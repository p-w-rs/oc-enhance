import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Backend } from "./backend.js"
import { documentKind, extractDocument, readBounded, render } from "./documents.js"
import { handoffMarkdown, handoffName, NOTES_GUIDE, notesText, parseHandoff, parseNotes, PausedError, RESUME_PROMPT, TaskNotes, type KV } from "./notes.js"
import { EnhanceRpc, type StateView } from "./rpc.js"
import { clearIndexes, folderSize, ProjectIndex } from "./search.js"
import { dataDirectory, PLUGIN_ID, SettingsStore, VERSION } from "./settings.js"
import { installTerminals } from "./terminal-tools.js"

export { PLUGIN_ID, VERSION }

export interface EnhanceOptions {
  /** Absolute path; default `$XDG_DATA_HOME/oc-enhance`. */
  readonly dataDirectory?: string
}

export function parseOptions(raw: unknown): EnhanceOptions {
  const options = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  if (options.dataDirectory !== undefined && (typeof options.dataDirectory !== "string" || !isAbsolute(options.dataDirectory))) throw new Error(`${PLUGIN_ID}: dataDirectory must be an absolute path`)
  return options.dataDirectory ? { dataDirectory: options.dataDirectory as string } : {}
}

const SKILLS = fileURLToPath(new URL("../skill/", import.meta.url))
/** Bundled know-how. `pixi` follows the Pixi setting, the others the know-how setting. */
const SKILL_IDS = ["pixi", "ml-training", "ml-deploy", "gpu-kernels"] as const
const PIXI_HINT = "Python only through Pixi: use `pixi run --script file.py` (PEP 723 inline dependencies) for standalone scripts and a Pixi workspace for projects; never call python, pip, uv, conda or venv directly. Prefer Pixi-managed toolchains for other languages too. Load the pixi skill for details."
const warn = (message: string, error?: unknown) => console.warn(`[${PLUGIN_ID}] ${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const blocked = (error: unknown) => record(error) && (error.name === "Permission.BlockedError" || (record(error.error) && error.error._tag === "Permission.BlockedError"))

export function createPlugin(): Plugin.Plugin {
  return ({
    id: PLUGIN_ID,
    async setup(ctx) {
      const registrations: { dispose(): Promise<void> | void }[] = []
      const cleanup = async () => { await Promise.allSettled(registrations.splice(0).reverse().map(async item => item.dispose())) }
      try {
        const options = parseOptions(ctx.options)
        const data = dataDirectory(options.dataDirectory)
        const settings = await SettingsStore.open(data)
        const backend = new Backend(join(data, "search"))
        const indexes = join(data, "indexes")
        const notes = new TaskNotes(ctx.storage as unknown as KV, {
          parent: async id => (await ctx.session.get({ sessionID: id as never })).parentID ?? undefined,
          children: async id => ((await ctx.session.list({ parentID: id as never, limit: 100 } as never)) as unknown as { data: { id: string }[] }).data.map(child => child.id),
          interrupt: async id => { await ctx.session.interrupt({ sessionID: id as never, resume: false } as never) },
        })

        const directory = async (context: ToolContext) => (await ctx.session.get({ sessionID: context.sessionID })).location.directory as string
        const assertAccess = (context: ToolContext, action: string, path: string) => ctx.permission.assert({
          sessionID: context.sessionID, agent: context.agent, action, resources: [path], save: [path],
          source: { type: "tool", messageID: context.messageID, id: context.id },
        } as never)
        const resolvePath = async (context: ToolContext, path: string) => isAbsolute(path) ? path : resolve(await directory(context), path)
        const text = (content: string, metadata: Record<string, unknown> = {}) => ({ content, metadata: { plugin: PLUGIN_ID, ...metadata } })

        // ---- Tools ----
        registrations.push(await ctx.tool.transform(editor => {
          const current = settings.current()
          if (current.notes) {
            editor.add({
              name: "save_task_notes",
              description: "Save this task's notes: goal, what is done, the next step, key decisions and important files. Call it when starting multi-step work and after each milestone; the notes are shown to you on every turn and let the user pause, resume or hand the work to someone else. Replaces the previous notes. No secrets.",
              input: {
                type: "object",
                properties: {
                  goal: { type: "string", maxLength: 2000, description: "What the user wants, including changes they asked for later" },
                  progress: { type: "string", maxLength: 2000, description: "What is done so far" },
                  next: { type: "string", maxLength: 2000, description: "The next concrete step" },
                  decisions: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } },
                  files: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 }, description: "Important files, relative to the project" },
                },
                required: ["goal", "progress", "next"], additionalProperties: false,
              } as never,
              options: { codemode: false },
              execute: async (input, context) => {
                await notes.save(context.sessionID, parseNotes(input))
                return text("Task notes saved.")
              },
            })
            editor.add({
              name: "task_handoff",
              description: "Hand work over between sessions or people. export: write this session's task notes to .opencode/handoffs/<name>.md in the project (commit it to share). import: load a handoff file's notes into this session, then continue the work. list: show the project's handoffs.",
              input: {
                type: "object",
                properties: {
                  action: { enum: ["export", "import", "list"] },
                  name: { type: "string", maxLength: 80, description: "export: file name (default: from the goal)" },
                  path: { type: "string", maxLength: 1000, description: "import: the handoff file (a name from list, or a path)" },
                },
                required: ["action"], additionalProperties: false,
              } as never,
              options: { codemode: false },
              execute: async (raw, context) => {
                const input = raw as { action: string; name?: string; path?: string }
                const handoffs = join(await directory(context), ".opencode", "handoffs")
                if (input.action === "list") {
                  const names = (await readdir(handoffs).catch(() => [] as string[])).filter(name => name.endsWith(".md")).sort()
                  return text(names.length ? `Handoffs in .opencode/handoffs:\n${names.map(name => `- ${name}`).join("\n")}` : "No handoffs in this project yet (.opencode/handoffs).")
                }
                if (input.action === "export") {
                  const entry = await notes.get(context.sessionID)
                  if (!entry.notes) throw new Error("Save task notes first (save_task_notes), then export them.")
                  const file = join(handoffs, `${handoffName(input.name ?? entry.notes.goal.split(/\s+/).slice(0, 6).join(" "))}.md`)
                  await assertAccess(context, "edit", file)
                  await mkdir(dirname(file), { recursive: true })
                  await writeFile(file, handoffMarkdown(entry.notes))
                  return text(`Handoff written to ${relative(await directory(context), file)}. Commit it to share it; anyone with oc-enhance can continue with task_handoff import, and anyone else can just read it.`, { path: file })
                }
                if (input.action === "import") {
                  if (!input.path) throw new Error("Give the handoff file to import (see task_handoff list)")
                  const file = input.path.includes("/") ? await resolvePath(context, input.path) : join(handoffs, input.path.endsWith(".md") ? input.path : `${input.path}.md`)
                  await assertAccess(context, "read", file)
                  const imported = parseHandoff(await readFile(file, "utf8"))
                  await notes.save(context.sessionID, imported)
                  return text(`Loaded the handoff's notes into this session (they are a summary; check the project before continuing):\n\n${notesText({ notes: imported })}`)
                }
                throw new Error("action must be export, import or list")
              },
            })
          }
          if (current.documents) {
            editor.add({
              name: "read_document",
              description: "Read Word (.docx), Excel (.xlsx), PowerPoint (.pptx) or PDF files as text, with paragraph ranges, slide numbers, sheet names or page numbers. Use part to read a section: \"3\", \"2-5\", a sheet name or a label. Native text only (no OCR for scanned pages). For plain text and code use the normal read tool.",
              input: {
                type: "object",
                properties: {
                  path: { type: "string", maxLength: 4000, description: "File path (relative to the project or absolute)" },
                  part: { type: "string", maxLength: 200, description: "Which part(s): \"3\", \"2-5\", \"1,4\", a sheet name, or a label from the parts list" },
                  maxChars: { type: "integer", minimum: 2000, maximum: 200000, description: "Output limit (default 60000)" },
                },
                required: ["path"], additionalProperties: false,
              } as never,
              options: { codemode: false },
              execute: async (raw, context) => {
                const input = raw as { path: string; part?: string; maxChars?: number }
                const file = await resolvePath(context, input.path)
                const kind = documentKind(file)
                if (!kind) throw new Error(`${basename(file)} is not a .docx, .xlsx, .pptx or .pdf file; use the read tool for other files`)
                await assertAccess(context, "read", file)
                const extracted = await extractDocument(await readBounded(file, undefined, context.signal), kind, context.signal)
                return text(render(basename(file), extracted, input.part, input.maxChars ?? 60_000), { path: file, parts: extracted.sections.length })
              },
            })
          }
          if (current.search) {
            editor.add({
              name: "search_project",
              description: "Find where something is described or implemented in this project when you don't know the exact words or file: searches by meaning (or keywords) across code, notes and documents (Word, Excel, PowerPoint, PDF). Returns the best passage per file with its location. Ranked, not exhaustive: for exact strings or every occurrence use grep.",
              input: {
                type: "object",
                properties: {
                  query: { type: "string", minLength: 1, maxLength: 2000, description: "What you are looking for, in plain words" },
                  mode: { enum: ["auto", "semantic", "keyword", "hybrid"], description: "auto (default): meaning-based when available, else keywords" },
                  limit: { type: "integer", minimum: 1, maximum: 20, description: "Results (default 8, one per file)" },
                  scope: { type: "string", maxLength: 1000, description: "Only this folder (relative to the project)" },
                },
                required: ["query"], additionalProperties: false,
              } as never,
              options: { codemode: false },
              execute: async (raw, context) => {
                const input = raw as { query: string; mode?: "auto" | "semantic" | "keyword" | "hybrid"; limit?: number; scope?: string }
                const root = await directory(context)
                const scope = input.scope && isAbsolute(input.scope) ? relative(root, input.scope) : input.scope ?? ""
                if (scope.startsWith("..")) throw new Error("scope must be a folder inside the project")
                const runtime = input.mode === "keyword" ? undefined : await backend.runtime()
                const output = await new ProjectIndex(indexes, root).search(input.query, { ...(input.mode && { mode: input.mode }), ...(input.limit && { limit: input.limit }), scope, ...(runtime && { runtime }), signal: context.signal })
                let hidden = 0
                const results = []
                for (const result of output.results) {
                  try { await assertAccess(context, "read", join(root, result.path)); results.push(result) }
                  catch (error) { if (blocked(error)) hidden++; else throw error }
                }
                const lines = [`${results.length} result(s), ${output.mode} ranking; ${output.coverage.files} files indexed${output.coverage.truncated ? " (index limit reached: narrow with scope for full coverage)" : ""}${hidden ? `; ${hidden} hidden by read permissions` : ""}.`]
                if (output.note) lines.push(output.note)
                results.forEach((result, index) => lines.push(`\n${index + 1}. ${result.path} (${result.where})\n${"```"}\n${result.excerpt}\n${"```"}`))
                if (!results.length) lines.push("No matches. This does not prove absence: try other words, mode keyword, or grep.")
                if (output.coverage.unreadable.length) lines.push(`\nCould not read: ${output.coverage.unreadable.slice(0, 5).map(item => `${item.path} (${item.reason})`).join("; ")}`)
                return text(lines.join("\n"), { mode: output.mode, results: results.length })
              },
            })
          }
        }))

        registrations.push(...await installTerminals(ctx, { enabled: () => settings.current().terminals, write: () => settings.current().terminalWrite }))

        // ---- Know-how (skills, loaded by agents only when needed) ----
        let skillReady = false
        try {
          const skills = await Promise.all(SKILL_IDS.map(async id => {
            const path = join(SKILLS, id, "SKILL.md")
            const content = await readFile(path, "utf8")
            return { id, path, content, description: /^description:\s*(.+)$/m.exec(content)?.[1] ?? id }
          }))
          registrations.push(await ctx.skill.transform(editor => {
            const current = settings.current()
            for (const skill of skills) {
              if (skill.id === "pixi" ? !current.pixi : !current.knowhow) continue
              editor.add({ id: skill.id as never, name: skill.id as never, description: skill.description, path: skill.path as never, content: skill.content })
            }
          }))
          skillReady = true
        } catch (error) { warn("skills not registered", error) }

        // ---- Pause gate, notes in context ----
        registrations.push(await ctx.tool.hook("execute.before", async input => {
          if (!settings.current().notes) return
          if (await notes.pausedBy(input.sessionID).catch(() => undefined)) throw new PausedError()
          notes.started(input.sessionID, input.id, input.tool)
        }))
        registrations.push(await ctx.tool.hook("execute.after", async input => { notes.finished(input.sessionID, input.id) }))
        registrations.push(await ctx.session.hook("prompt", async input => {
          if (!settings.current().notes) return
          try {
            // A new message from the user means "carry on": it resumes a paused session.
            if ((await notes.get(input.sessionID)).paused) await notes.resume(input.sessionID)
            const prompt = input.prompt as { text?: unknown }
            if (typeof prompt.text === "string") await notes.remember(input.sessionID, prompt.text)
          } catch (error) { warn("could not update task notes", error) }
        }))
        registrations.push(await ctx.session.hook("context", async input => {
          const current = settings.current()
          if (current.notes) {
            let paused: string | undefined
            try { paused = await notes.pausedBy(input.sessionID) } catch {}
            if (paused) throw new PausedError()
            if (!input.tools || "save_task_notes" in input.tools) {
              input.system.push({ type: "text", text: NOTES_GUIDE } as never)
              try {
                const saved = notesText(await notes.get(input.sessionID))
                if (saved) input.system.push({ type: "text", text: `Current task notes (saved earlier in this session; the user's latest message takes precedence):\n${saved}` } as never)
              } catch {}
            }
          }
          if (current.pixi) input.system.push({ type: "text", text: PIXI_HINT } as never)
        }))

        const pause = async (sessionID: string) => {
          if (!settings.current().notes) throw new Error("Pause is turned off in Settings → Enhance")
          return notes.pause(sessionID)
        }
        const resume = async (sessionID: string, carryOn = true) => {
          const was = await notes.resume(sessionID)
          if (was && carryOn) await ctx.session.prompt({ sessionID: sessionID as never, text: RESUME_PROMPT } as never)
          return was
        }
        registrations.push(await ctx.command.transform(editor => {
          editor.add({ name: "pause", description: "Pause this session: stop the agent now and keep it stopped until you resume (oc-enhance)", execute: async ({ sessionID }) => { await pause(sessionID) } })
          editor.add({ name: "resume", description: "Resume a paused session; the agent continues from its task notes (oc-enhance)", execute: async ({ sessionID }) => { await resume(sessionID) } })
        }))

        // ---- Settings changes from the GUI or another process ----
        let reloading: Promise<void> | undefined
        const reload = () => {
          reloading ??= Promise.all([ctx.tool.reload(), skillReady ? ctx.skill.reload() : undefined]).then(() => {}).catch(error => warn("reload failed", error)).finally(() => { reloading = undefined })
          return reloading
        }
        registrations.push({ dispose: settings.watch(() => void reload()) })

        // ---- GUI ----
        const sessionView = async (sessionID: string) => {
          const entry = await notes.get(sessionID)
          return {
            paused: !!(await notes.pausedBy(sessionID)),
            ...(entry.paused && { pausedAt: entry.paused.at, interrupted: entry.paused.interrupted }),
            ...(entry.notes && { notes: entry.notes }), ...(entry.request && { request: entry.request }),
          }
        }
        const state = async (sessionID?: string): Promise<StateView> => ({
          version: VERSION, settings: settings.current(), dataDirectory: data,
          search: { ...await backend.status(), indexBytes: await folderSize(indexes) + await folderSize(join(data, "search", "home")), engineBytes: await folderSize(backend.runtimeDir) },
          ...(sessionID && { session: await sessionView(sessionID) }),
        })
        const sessionInput = (input: unknown) => {
          const id = record(input) ? input.sessionID : undefined
          if (typeof id !== "string" || !id) throw new Error("sessionID required")
          return id
        }
        registrations.push(await ctx.rpc.register(EnhanceRpc, {
          state: async (input: unknown) => state(record(input) && typeof input.sessionID === "string" ? input.sessionID : undefined),
          session: async (input: unknown) => sessionView(sessionInput(input)),
          update: async (input: unknown) => { await settings.update(input); await reload(); return state() },
          installSearch: async () => { void backend.install().catch(error => warn("search setup failed", error)); return state() },
          removeSearch: async () => { await backend.remove(); return state() },
          clearIndexes: async () => { await clearIndexes(indexes); await clearIndexes(join(data, "search", "home")); return state() },
          pause: async (input: unknown) => { const id = sessionInput(input); await pause(id); return sessionView(id) },
          resume: async (input: unknown) => { const id = sessionInput(input); await resume(id, !(record(input) && input.continue === false)); return sessionView(id) },
        } as never))
      } catch (error) {
        warn("disabled", error)
        await cleanup()
      }
      return cleanup
    },
  }) satisfies Plugin.Plugin
}

export default createPlugin()
