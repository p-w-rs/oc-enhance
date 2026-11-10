import { after, test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import plugin, { createPlugin, parseOptions, PLUGIN_ID } from "./index.js"
import { docx } from "./testdocs.js"

const dirs: string[] = []
after(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })
const scratch = async () => { const dir = await mkdtemp(join(tmpdir(), "oce-")); dirs.push(dir); return dir }

type Tool = { name: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }

async function host(options: { deny?: (action: string, path: string) => boolean } = {}) {
  const data = await scratch()
  const project = await scratch()
  const transforms: ((editor: any) => void)[] = []
  const skillTransforms: ((editor: any) => void)[] = []
  const tools = new Map<string, Tool>()
  const skills: { id: string }[] = []
  const hooks: Record<string, ((input: any) => Promise<void>)[]> = {}
  const commands = new Map<string, (input: any) => Promise<void>>()
  const asked: { action: string; resources: string[] }[] = []
  const prompts: { sessionID: string; text: string }[] = []
  const interrupted: string[] = []
  const store = new Map<string, unknown>()
  const parents: Record<string, string | undefined> = { s: undefined, sub: "s", other: undefined }
  let rpc: any
  const rebuild = () => { tools.clear(); for (const t of transforms) t({ add: (tool: Tool) => tools.set(tool.name, tool) }) }
  const rebuildSkills = () => { skills.length = 0; for (const t of skillTransforms) t({ add: (skill: any) => skills.push(skill) }) }
  const hook = async (name: string, callback: any) => { (hooks[name] ??= []).push(callback); return { dispose: async () => {} } }
  const ctx = {
    options: { dataDirectory: data },
    storage: { get: async (k: string) => structuredClone(store.get(k)), set: async (k: string, v: unknown) => { store.set(k, structuredClone(v)) }, remove: async (k: string) => { store.delete(k) } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: parents[sessionID], location: { directory: project } }),
      list: async ({ parentID }: { parentID: string }) => ({ data: Object.keys(parents).filter(id => parents[id] === parentID).map(id => ({ id, parentID })) }),
      interrupt: async ({ sessionID }: { sessionID: string }) => { interrupted.push(sessionID) },
      prompt: async (input: { sessionID: string; text: string }) => { prompts.push(input) },
      hook: (name: string, callback: any) => hook(`session.${name}`, callback),
    },
    permission: {
      assert: async (input: { action: string; resources: string[] }) => {
        asked.push({ action: input.action, resources: input.resources })
        if (options.deny?.(input.action, input.resources[0]!)) throw Object.assign(new Error("denied"), { name: "Permission.BlockedError" })
      },
    },
    tool: {
      transform: async (callback: any) => { transforms.push(callback); rebuild(); return { dispose: async () => { transforms.splice(transforms.indexOf(callback), 1); rebuild() } } },
      reload: async () => rebuild(),
      hook: (name: string, callback: any) => hook(`tool.${name}`, callback),
    },
    skill: {
      transform: async (callback: any) => { skillTransforms.push(callback); rebuildSkills(); return { dispose: async () => {} } },
      reload: async () => rebuildSkills(),
    },
    command: { transform: async (callback: any) => { callback({ add: (c: any) => commands.set(c.name, c.execute) }); return { dispose: async () => {} } } },
    rpc: { register: async (definition: { id: string }, handlers: any) => { if (definition.id === "oc-enhance.admin") rpc = handlers; return { dispose: async () => {}, events: { emit: async () => {} } } } },
  }
  const cleanup = await createPlugin().setup(ctx as unknown as Plugin.Context) as () => Promise<void>
  let n = 0
  const call = async (name: string, input: unknown, sessionID = "s") => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`no tool ${name}`)
    return (await tool.execute(input, { sessionID, agent: "build", messageID: "m", id: `c${++n}`, signal: new AbortController().signal, progress: async () => {} })).content
  }
  const run = async (name: string, input: any) => { for (const callback of hooks[name] ?? []) await callback(input) }
  const context = async (sessionID = "s") => { const input = { sessionID, system: [] as { text: string }[], tools: Object.fromEntries([...tools.keys()].map(k => [k, {}])) }; await run("session.context", input); return input.system.map(part => part.text).join("\n---\n") }
  return { data, project, tools, skills, asked, prompts, interrupted, commands, call, run, context, cleanup, rpc: () => rpc }
}

test("identity and options", () => {
  assert.equal(plugin.id, PLUGIN_ID)
  assert.deepEqual(parseOptions({}), {})
  assert.throws(() => parseOptions({ dataDirectory: "relative" }), /absolute/)
})

test("all features on by default: tools, pixi skill and guidance; turning features off removes them", async () => {
  const h = await host()
  assert.deepEqual([...h.tools.keys()].sort(), ["read_document", "save_task_notes", "search_project", "task_handoff", "terminal_list", "terminal_open", "terminal_read", "terminal_write"])
  assert.deepEqual(h.skills.map(s => s.id), ["pixi"])
  const system = await h.context()
  assert.match(system, /Task notes \(oc-enhance\)/)
  assert.match(system, /Python only through Pixi/)
  await h.rpc().update({ documents: false, terminals: false, pixi: false })
  assert.deepEqual([...h.tools.keys()].sort(), ["save_task_notes", "search_project", "task_handoff"])
  assert.deepEqual(h.skills, [])
  assert.doesNotMatch(await h.context(), /Pixi/)
  const state = await h.rpc().state({})
  assert.equal(state.settings.documents, false)
  assert.equal(state.search.supported, true)
  await h.cleanup()
})

test("read_document: checks native read permission, reads by part", async () => {
  const h = await host({ deny: (action, path) => action === "read" && path.endsWith("secret.docx") })
  await writeFile(join(h.project, "policy.docx"), docx(["Intro", "Refunds within 30 days."]))
  await writeFile(join(h.project, "secret.docx"), docx(["x"]))
  const output = await h.call("read_document", { path: "policy.docx" })
  assert.match(output, /# policy\.docx\n\nWord document, 2 paragraphs/)
  assert.match(output, /Refunds within 30 days\./)
  assert.deepEqual(h.asked.at(-1), { action: "read", resources: [join(h.project, "policy.docx")] })
  await assert.rejects(h.call("read_document", { path: "secret.docx" }), /denied/)
  await assert.rejects(h.call("read_document", { path: "notes.txt" }), /use the read tool/)
  await h.cleanup()
})

test("search_project: finds documents and code, hides files the agent may not read", async () => {
  const h = await host({ deny: (action, path) => action === "read" && path.includes("hr/") })
  await mkdir(join(h.project, "hr")); await mkdir(join(h.project, "src"))
  await writeFile(join(h.project, "travel.docx"), docx(["Hotels are covered when a flight is cancelled overnight."]))
  await writeFile(join(h.project, "hr", "salaries.md"), "flight cancelled hotel salaries\n")
  await writeFile(join(h.project, "src", "a.ts"), "export const x = 1\n")
  const output = await h.call("search_project", { query: "flight cancelled hotel", mode: "keyword" })
  assert.match(output, /1\. travel\.docx \(paragraphs 1-1\)/)
  assert.doesNotMatch(output, /salaries/)
  assert.match(output, /1 hidden by read permissions/)
  await h.cleanup()
})

test("task notes: saved, shown every turn; the first request is kept automatically", async () => {
  const h = await host()
  await h.run("session.prompt", { sessionID: "s", prompt: { text: "Port the importer to Rust" } })
  assert.match(await h.context(), /The user's original request: Port the importer to Rust/)
  await h.call("save_task_notes", { goal: "Port the importer to Rust", progress: "Parser done", next: "Write tests", files: ["src/import.rs"] })
  assert.match(await h.context(), /Goal: Port the importer to Rust\nDone so far: Parser done\nNext: Write tests\nFiles: src\/import.rs/)
  await h.cleanup()
})

test("pause stops the session tree and holds it; resume continues; a new message also resumes", async () => {
  const h = await host()
  await h.run("tool.execute.before", { sessionID: "sub", id: "t1", tool: "shell" })
  const view = await h.rpc().pause({ sessionID: "s" })
  assert.equal(view.paused, true)
  assert.deepEqual(view.interrupted, ["shell"])
  assert.deepEqual(h.interrupted.sort(), ["s", "sub"])
  await assert.rejects(h.run("tool.execute.before", { sessionID: "sub", id: "t2", tool: "read" }), /Paused by the user/)
  await assert.rejects(h.context("s"), /Paused by the user/)
  await h.run("tool.execute.before", { sessionID: "other", id: "t3", tool: "read" })
  assert.equal((await h.rpc().resume({ sessionID: "s" })).paused, false)
  assert.match(h.prompts.at(-1)!.text, /Resume the paused task/)
  await h.run("tool.execute.before", { sessionID: "sub", id: "t4", tool: "read" })

  await h.commands.get("pause")!({ sessionID: "s" })
  await h.run("session.prompt", { sessionID: "s", prompt: { text: "ok carry on" } })
  assert.equal((await h.rpc().session({ sessionID: "s" })).paused, false, "a new message resumes")
  await h.cleanup()
})

test("handoff: export to .opencode/handoffs, list, import in another session", async () => {
  const h = await host()
  await h.call("save_task_notes", { goal: "Fix flaky upload test", progress: "Reproduced", next: "Add retry", decisions: ["No sleeps"] })
  const exported = await h.call("task_handoff", { action: "export" })
  assert.match(exported, /\.opencode\/handoffs\/fix-flaky-upload-test\.md/)
  const file = await readFile(join(h.project, ".opencode", "handoffs", "fix-flaky-upload-test.md"), "utf8")
  assert.match(file, /^# Handoff: Fix flaky upload test/)
  assert.ok(h.asked.some(a => a.action === "edit"), "writing the file checks edit permission")
  assert.match(await h.call("task_handoff", { action: "list" }), /fix-flaky-upload-test\.md/)
  const imported = await h.call("task_handoff", { action: "import", path: "fix-flaky-upload-test" }, "other")
  assert.match(imported, /Goal: Fix flaky upload test/)
  assert.match(await h.context("other"), /Next: Add retry/)
  await h.cleanup()
})

test("a broken data directory disables the plugin without throwing", async () => {
  const file = join(await scratch(), "not-a-dir")
  await writeFile(file, "x")
  const warnings: string[] = []
  const original = console.warn
  console.warn = (message: string) => { warnings.push(message) }
  try {
    const cleanup = await createPlugin().setup({ options: { dataDirectory: join(file, "sub") } } as unknown as Plugin.Context) as () => Promise<void>
    await cleanup()
  } finally { console.warn = original }
  assert.match(warnings.join("\n"), /\[oc-enhance\] disabled/)
})
