// Task notes, Pause/Resume and handoffs.
// Notes: the agent saves goal / progress / next step / decisions / files; they are shown to the model on every
// request, so work continues correctly after Pause, a restart or a long break. Pause interrupts the session (and its
// subagents) and holds new tool calls and model requests until the user resumes or sends a new message.
// Handoffs: notes written to .opencode/handoffs/<name>.md in the project, so someone else can continue.

export interface Notes {
  readonly goal: string
  readonly progress: string
  readonly next: string
  readonly decisions: readonly string[]
  readonly files: readonly string[]
}
export interface SessionNotes {
  notes?: Notes
  /** The user's first request, kept automatically until the agent saves notes. */
  request?: string
  /**
   * interrupted: what was running when paused; background: background shells the pause stopped;
   * checkpoint: whether the agent's notes were brought up to date at the pause.
   */
  paused?: { at: number; interrupted: string[]; background?: string[]; checkpoint?: "saving" | "saved" | "failed" }
  /** When the notes were last saved, and by whom ("agent" or the pause "checkpoint"). */
  saved?: { at: number; by: "agent" | "checkpoint" }
  updated?: number
}

export interface KV {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export class PausedError extends Error {
  constructor() { super("Paused by the user. Nothing runs until the user resumes this session (Resume, /resume, or a new message).") }
}

const LIMIT = { text: 2000, item: 300, items: 20 }
const clean = (value: unknown, max: number, name: string): string => {
  if (typeof value !== "string") throw new Error(`${name} must be text`)
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim()
  if (text.length > max) throw new Error(`${name} is longer than ${max} characters; summarize it`)
  return text
}
const list = (value: unknown, name: string): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > LIMIT.items) throw new Error(`${name} must be a list of at most ${LIMIT.items} items`)
  return value.map((item, index) => clean(item, LIMIT.item, `${name}[${index}]`)).filter(Boolean)
}

export function parseNotes(input: unknown): Notes {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const notes = {
    goal: clean(value.goal, LIMIT.text, "goal"), progress: clean(value.progress ?? "", LIMIT.text, "progress"), next: clean(value.next ?? "", LIMIT.text, "next"),
    decisions: list(value.decisions, "decisions"), files: list(value.files, "files"),
  }
  if (!notes.goal) throw new Error("goal is required")
  return notes
}

export function notesText(entry: SessionNotes): string | undefined {
  const notes = entry.notes
  if (!notes) return entry.request ? `The user's original request: ${entry.request}` : undefined
  return [
    `Goal: ${notes.goal}`, notes.progress && `Done so far: ${notes.progress}`, notes.next && `Next: ${notes.next}`,
    notes.decisions.length && `Decisions: ${notes.decisions.join("; ")}`, notes.files.length && `Files: ${notes.files.join(", ")}`,
  ].filter(Boolean).join("\n")
}

export const NOTES_GUIDE = "Task notes (oc-enhance): for any task that takes more than a few steps, call save_task_notes when you start, after each milestone, at least every ~8 tool calls, and before you end a turn with work still pending (goal, done so far, next step, key decisions, important files). Write them so someone could continue from them alone. They are shown to you every turn, survive pauses, restarts and context compaction, and can be handed over with task_handoff. Skip them for quick one-step requests. Never put secrets in notes."

// ---- Handoff files (Markdown, readable by people and by agents) ----

const HEADINGS: Record<string, keyof Notes> = { goal: "goal", "done so far": "progress", next: "next", decisions: "decisions", files: "files" }

export function handoffMarkdown(notes: Notes, date = new Date()): string {
  const bullets = (items: readonly string[]) => items.length ? items.map(item => `- ${item}`).join("\n") : "- (none)"
  return `# Handoff: ${notes.goal.split("\n")[0]!.slice(0, 120)}

_Task notes exported from OpenCode (oc-enhance) on ${date.toISOString().slice(0, 10)}. They are a summary, not verified facts: check the project before continuing. Continue with: "continue the handoff in <this file>"._

## Goal

${notes.goal}

## Done so far

${notes.progress || "(nothing recorded)"}

## Next

${notes.next || "(not recorded)"}

## Decisions

${bullets(notes.decisions)}

## Files

${bullets(notes.files)}
`
}

export function parseHandoff(markdown: string): Notes {
  const parts: Record<string, string> = {}
  let current: string | undefined
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) { current = HEADINGS[heading[1]!.toLowerCase()]; if (current) parts[current] = ""; continue }
    if (current) parts[current] += `${line}\n`
  }
  const text = (key: string) => (parts[key] ?? "").trim().replace(/^\((nothing recorded|not recorded)\)$/, "")
  const items = (key: string) => (parts[key] ?? "").split("\n").map(line => line.replace(/^\s*[-*]\s+/, "").trim()).filter(item => item && item !== "(none)")
  return parseNotes({ goal: text("goal"), progress: text("progress"), next: text("next"), decisions: items("decisions").slice(0, LIMIT.items), files: items("files").slice(0, LIMIT.items) })
}

export const handoffName = (name: string) => {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 60)
  if (!slug) throw new Error("Give the handoff a name with letters or digits")
  return slug
}

// ---- State per session, in OpenCode's plugin storage ----

export interface SessionHost {
  parent(sessionID: string): Promise<string | undefined>
  children(sessionID: string): Promise<string[]>
  interrupt(sessionID: string): Promise<void>
  /** Stops these background shell commands; returns the ones that were running. */
  stopShells?(commands: string[]): Promise<string[]>
}

/**
 * Live activity, shared by every plugin instance in this OpenCode process (OpenCode creates one instance per project
 * location, and the Pause button may reach a different one than the instance that saw the tool start).
 */
interface Activity {
  running: Map<string, Map<string, string>>
  /** session → shell ID → what to show, and the exact command (to find its process). */
  background: Map<string, Map<string, { label: string; command: string }>>
  calls: Map<string, { total: number; atNotes: number }>
  /** Sessions whose context was just compacted (the next turn asks for fresh notes). */
  compacted: Set<string>
}
const ACTIVITY = Symbol.for("oc-enhance.activity.v2")
const activity: Activity = ((globalThis as Record<symbol, unknown>)[ACTIVITY] ??= { running: new Map(), background: new Map(), calls: new Map(), compacted: new Set() }) as Activity

/** A short description of a tool call for people: "shell: sleep 45 && …", "write: notes.txt". */
export function describeCall(tool: string, input: unknown): string {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {}
  const detail = [value.command, value.description, value.path, value.filePath, value.url, value.query, value.prompt].find(item => typeof item === "string" && item.trim()) as string | undefined
  const short = detail?.replace(/\s+/g, " ").trim()
  return short ? `${tool}: ${short.length > 80 ? `${short.slice(0, 80)}…` : short}` : tool
}

export class TaskNotes {
  readonly #running = activity.running
  readonly #parents = new Map<string, string | undefined>()
  #queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly kv: KV, private readonly host: SessionHost) {}

  #key = (sessionID: string) => `session/${sessionID}`
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => {}).then(fn)
    this.#queue = next.catch(() => {})
    return next
  }

  async get(sessionID: string): Promise<SessionNotes> {
    const value = await this.kv.get(this.#key(sessionID))
    return value && typeof value === "object" ? value as SessionNotes : {}
  }
  #update(sessionID: string, change: (entry: SessionNotes) => void): Promise<SessionNotes> {
    return this.#serial(async () => {
      const entry = await this.get(sessionID)
      change(entry)
      entry.updated = Date.now()
      await this.kv.set(this.#key(sessionID), entry as never)
      return entry
    })
  }

  save(sessionID: string, notes: Notes, by: "agent" | "checkpoint" = "agent") {
    const count = activity.calls.get(sessionID)
    if (count) count.atNotes = count.total
    activity.compacted.delete(sessionID)
    return this.#update(sessionID, entry => { entry.notes = notes; entry.saved = { at: Date.now(), by } })
  }
  /** Records the state of the pause checkpoint. */
  checkpointed(sessionID: string, state: "saving" | "saved" | "failed") {
    return this.#update(sessionID, entry => { if (entry.paused) entry.paused.checkpoint = state })
  }
  compacted(sessionID: string) { activity.compacted.add(sessionID) }
  wasCompacted(sessionID: string) { return activity.compacted.has(sessionID) }
  remember(sessionID: string, request: string) {
    return this.#update(sessionID, entry => { if (!entry.notes && !entry.request && request.trim()) entry.request = request.trim().slice(0, 500) })
  }

  async #ancestry(sessionID: string): Promise<string[]> {
    const chain: string[] = []
    let current: string | undefined = sessionID
    while (current && chain.length < 32 && !chain.includes(current)) {
      chain.push(current)
      if (!this.#parents.has(current)) this.#parents.set(current, await this.host.parent(current).catch(() => undefined))
      current = this.#parents.get(current)
    }
    return chain
  }

  /** The paused session (this one or an ancestor), if any. */
  async pausedBy(sessionID: string): Promise<string | undefined> {
    for (const id of await this.#ancestry(sessionID)) if ((await this.get(id)).paused) return id
    return undefined
  }

  started(sessionID: string, callID: string, label: string) {
    let calls = this.#running.get(sessionID)
    if (!calls) this.#running.set(sessionID, calls = new Map())
    calls.set(callID, label)
    const count = activity.calls.get(sessionID) ?? { total: 0, atNotes: 0 }
    count.total++
    activity.calls.set(sessionID, count)
  }
  finished(sessionID: string, callID: string) { this.#running.get(sessionID)?.delete(callID) }

  /** A shell the agent moved to the background keeps running while paused; remember it so Pause can say so. */
  backgrounded(sessionID: string, shellID: string, label: string, command: string) {
    let shells = activity.background.get(sessionID)
    if (!shells) activity.background.set(sessionID, shells = new Map())
    shells.set(shellID, { label, command })
  }
  shellEnded(shellID: string) { for (const shells of activity.background.values()) shells.delete(shellID) }

  /** Tool calls since the notes were last saved (undefined: none yet in this process). */
  callsSinceNotes(sessionID: string): { total: number; sinceNotes: number } {
    const count = activity.calls.get(sessionID) ?? { total: 0, atNotes: 0 }
    return { total: count.total, sinceNotes: count.total - count.atNotes }
  }

  /**
   * Saves the pause first (so nothing new starts), then interrupts the session and its subagents and stops the
   * background shells they started.
   */
  async pause(sessionID: string): Promise<{ interrupted: string[]; background: string[]; failed: string[]; worked: boolean }> {
    const sessions = [sessionID]
    for (let index = 0; index < sessions.length && sessions.length < 200; index++) {
      for (const child of await this.host.children(sessions[index]!).catch(() => [] as string[])) if (!sessions.includes(child)) sessions.push(child)
    }
    const interrupted = sessions.flatMap(id => [...(this.#running.get(id)?.values() ?? [])]).filter(label => !/^save_task_notes/.test(label))
    const shells = sessions.flatMap(id => [...(activity.background.get(id)?.entries() ?? [])].map(([shellID, shell]) => ({ sessionID: id, shellID, ...shell })))
    await this.#update(sessionID, entry => { entry.paused = { at: Date.now(), interrupted } })
    const failed: string[] = []
    await Promise.all(sessions.map(async id => { try { await this.host.interrupt(id) } catch { failed.push(id) } }))
    let background: string[] = []
    if (shells.length && this.host.stopShells) {
      const squash = (text: string) => text.replace(/\s+/g, " ").trim()
      const stopped = new Set((await this.host.stopShells(shells.map(shell => shell.command)).catch(() => [] as string[])).map(squash))
      background = shells.filter(shell => stopped.has(squash(shell.command))).map(shell => shell.label)
      for (const shell of shells) activity.background.get(shell.sessionID)?.delete(shell.shellID)
      if (background.length) await this.#update(sessionID, entry => { if (entry.paused) entry.paused.background = background })
    }
    // Whether the agent did anything in this tree since this OpenCode process started (a checkpoint is worth asking for).
    const worked = sessions.some(id => (activity.calls.get(id)?.total ?? 0) > 0)
    return { interrupted, background, failed, worked }
  }

  /** Clears the pause; returns what the pause recorded (undefined if the session was not paused). */
  async resume(sessionID: string): Promise<SessionNotes["paused"]> {
    let was: SessionNotes["paused"]
    await this.#update(sessionID, entry => { was = entry.paused; delete entry.paused })
    return was
  }

  forget(sessionID: string) { return this.#serial(() => this.kv.remove(this.#key(sessionID))) }
}

export const RESUME_PROMPT = "Resume the paused task. Check your task notes and the current state of the files first; work that was interrupted may be incomplete, so verify it instead of assuming it finished. Do not blindly repeat commands that change things."

/** The message that continues a paused session: what was interrupted or stopped, and reminders that came due. */
export function resumePrompt(paused: SessionNotes["paused"], reminders: readonly string[] = []): string {
  const minutes = paused ? Math.round((Date.now() - paused.at) / 60000) : 0
  return [
    RESUME_PROMPT,
    paused?.checkpoint === "saved" ? "Your task notes were updated when the pause started; continue from their next step." : "",
    paused?.interrupted.length ? `Interrupted by the pause${minutes ? ` ${minutes} min ago` : ""}: ${[...new Set(paused.interrupted)].join("; ")}. Check whether each one completed (look at the files or outputs it should have produced) before redoing it.` : "",
    paused?.background?.length ? `The pause also stopped these background commands: ${paused.background.join("; ")}. They did not finish; check what they left behind and start them again if they are still needed.` : "",
    reminders.length ? `Reminders that came due while paused:\n${reminders.join("\n")}` : "",
  ].filter(Boolean).join("\n")
}

/** The request for a notes checkpoint when the user pauses (answered by the session's own model, with its context). */
export const CHECKPOINT_MARK = "[oc-enhance pause checkpoint]"
export function checkpointPrompt(paused: SessionNotes["paused"]): string {
  return [
    `${CHECKPOINT_MARK} The user just paused this session. Before it stops, write your task notes as a checkpoint so that you, or a colleague, can resume exactly where you left off.`,
    paused?.interrupted.length ? `The pause interrupted: ${paused.interrupted.join("; ")}. These may be incomplete.` : "",
    paused?.background?.length ? `The pause stopped these background commands: ${paused.background.join("; ")}.` : "",
    'Reply with only a JSON object: {"goal": "...", "progress": "...", "next": "...", "decisions": ["..."], "files": ["..."]}.',
    "goal: what the user wants, including later changes. progress: what is done and verified, and what was in progress and may be incomplete. next: the exact next step. decisions: key choices made. files: important files. Each text under 1500 characters; no secrets; no other text.",
  ].filter(Boolean).join("\n")
}

/** Reads the checkpoint reply: a JSON object, possibly inside a code fence. */
export function parseCheckpoint(text: string): Notes {
  const start = text.indexOf("{"), end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("checkpoint reply has no JSON object")
  const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  const cut = (item: unknown, max: number) => typeof item === "string" ? item.slice(0, max) : item
  const items = (item: unknown) => Array.isArray(item) ? item.slice(0, LIMIT.items).map(entry => cut(String(entry), LIMIT.item)) : undefined
  return parseNotes({ goal: cut(value.goal, LIMIT.text), progress: cut(value.progress ?? "", LIMIT.text), next: cut(value.next ?? "", LIMIT.text), decisions: items(value.decisions), files: items(value.files) })
}

/** A nudge when a task has no (or stale) notes, or the context was just compacted; undefined when notes are fine. */
export function notesNudge(hasNotes: boolean, total: number, sinceNotes: number, compacted = false): string | undefined {
  if (compacted && total >= 1) return "The conversation was just compacted, so older details are now only in the summary. Update your task notes with save_task_notes now (goal, done so far, next step), so nothing important is lost."
  if (!hasNotes && total >= 4) return `You have made ${total} tool calls in this task without saving task notes. Call save_task_notes now (goal, done so far, next step), so the work survives a pause, a restart or a handoff.`
  if (hasNotes && sinceNotes >= 8) return `Your task notes are ${sinceNotes} tool calls old. Update them with save_task_notes (done so far, next step) now.`
  return undefined
}
