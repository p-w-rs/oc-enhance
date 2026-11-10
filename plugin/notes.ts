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
  paused?: { at: number; interrupted: string[] }
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

export const NOTES_GUIDE = "Task notes (oc-enhance): for multi-step work, call save_task_notes when you start and after each milestone (goal, done so far, next step, key decisions, important files). They let the user pause and resume, survive restarts, and can be handed to someone else with task_handoff. Skip them for quick one-step requests. Never put secrets in notes."

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
}

export class TaskNotes {
  readonly #running = new Map<string, Map<string, string>>()
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

  save(sessionID: string, notes: Notes) { return this.#update(sessionID, entry => { entry.notes = notes }) }
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

  started(sessionID: string, callID: string, tool: string) {
    let calls = this.#running.get(sessionID)
    if (!calls) this.#running.set(sessionID, calls = new Map())
    calls.set(callID, tool)
  }
  finished(sessionID: string, callID: string) { this.#running.get(sessionID)?.delete(callID) }

  /** Saves the pause first, then interrupts the session and its subagents. */
  async pause(sessionID: string): Promise<{ interrupted: string[]; failed: string[] }> {
    const sessions = [sessionID]
    for (let index = 0; index < sessions.length && sessions.length < 200; index++) {
      for (const child of await this.host.children(sessions[index]!).catch(() => [] as string[])) if (!sessions.includes(child)) sessions.push(child)
    }
    const interrupted = sessions.flatMap(id => [...(this.#running.get(id)?.values() ?? [])])
    await this.#update(sessionID, entry => { entry.paused = { at: Date.now(), interrupted } })
    const failed: string[] = []
    await Promise.all(sessions.map(async id => { try { await this.host.interrupt(id) } catch { failed.push(id) } }))
    return { interrupted, failed }
  }

  async resume(sessionID: string): Promise<boolean> {
    let was = false
    await this.#update(sessionID, entry => { was = !!entry.paused; delete entry.paused })
    return was
  }

  forget(sessionID: string) { return this.#serial(() => this.kv.remove(this.#key(sessionID))) }
}

export const RESUME_PROMPT = "Resume the paused task. Check your task notes and the current state of the files first; work that was interrupted may be incomplete, so verify it instead of assuming it finished. Do not blindly repeat commands that change things."
