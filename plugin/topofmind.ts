// Top of mind: in long chats agents forget capabilities they have (a tool for Office files, reminders, a skill, the
// reference library). Each model request gets at most a few short cues for the capabilities this moment calls for,
// chosen from the session's own tools and skills (OpenCode's built-ins, every plugin, MCP) by simple rules and, if the
// user picked one in Settings, a fast model that runs in the background between turns and never delays a request.
// Cues go at the end of the context (prompt caching keeps working), each at most twice per user message, and not for
// capabilities the agent already used for it.

export interface Capability { readonly name: string; readonly kind: "tool" | "skill"; readonly summary: string }
export interface Cue { readonly name: string; readonly why: string; readonly source: "rule" | "model" }

/** One line per capability: the tool's or skill's own description, first sentence. */
export function capabilityIndex(tools: Record<string, { description?: string }> | undefined, skills: readonly { name: string; description?: string }[] = []): Capability[] {
  const first = (text = "") => { const line = text.replace(/\s+/g, " ").trim(); const end = line.search(/(?<=[.!?])\s/); return (end > 0 ? line.slice(0, end) : line).slice(0, 180) }
  return [
    ...Object.entries(tools ?? {}).filter(([name]) => name !== "skill").map(([name, tool]) => ({ name, kind: "tool" as const, summary: first(tool.description) })),
    ...skills.map(skill => ({ name: `skill:${skill.name}`, kind: "skill" as const, summary: first(skill.description) })),
  ]
}

export interface Recent {
  /** The latest message from the user (empty when there is none). */
  readonly user: string
  /** The recent conversation as plain text, newest last, for the model and the rules. */
  readonly text: string
  /** Capabilities used since the latest user message ("read_document", "skill:pixi"). */
  readonly used: ReadonlySet<string>
  /** Tool calls in the whole visible conversation. */
  readonly calls: number
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(part => {
    const value = part as Record<string, unknown>
    if (typeof value.text === "string") return value.text
    if (value.type === "tool-call") return `[called ${String(value.name)}${value.input ? ` ${JSON.stringify(value.input).slice(0, 200)}` : ""}]`
    if (value.type === "tool-result") return `[result ${typeof value.result === "string" ? value.result.slice(0, 300) : JSON.stringify(value.result ?? value.output ?? "").slice(0, 300)}]`
    return ""
  }).filter(Boolean).join("\n")
}

/** Reads the request's messages (OpenCode's model messages: user, assistant with tool calls, tool results). */
export function recent(messages: unknown): Recent {
  const list = Array.isArray(messages) ? messages as { role?: string; content?: unknown }[] : []
  let lastUser = -1
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index]!
    // Our own cues and nudges come as system messages; plugin reminders and wake-ups are user-role text too.
    if (message.role === "user" && textOf(message.content).trim() && !/^\s*<(reminder|shell|subagent|system-reminder)\b/.test(textOf(message.content))) { lastUser = index; break }
  }
  const used = new Set<string>()
  let calls = 0
  list.forEach((message, index) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return
    for (const part of message.content as Record<string, unknown>[]) {
      if (part.type !== "tool-call") continue
      calls++
      if (index < lastUser) continue
      const name = String(part.name)
      used.add(name)
      const input = part.input as Record<string, unknown> | undefined
      if (name === "skill" && input) used.add(`skill:${String(input.name ?? input.id ?? "")}`)
    }
  })
  const user = lastUser >= 0 ? textOf(list[lastUser]!.content).trim() : ""
  const tail = list.slice(-12).filter(message => message.role !== "system").map(message => `${message.role}: ${textOf(message.content)}`).join("\n")
  return { user, text: tail.slice(-6000), used, calls }
}

interface Rule { readonly name: string; readonly when: (recent: Recent) => boolean; readonly why: string }
const has = (pattern: RegExp) => (recent: Recent) => pattern.test(recent.user)
const RULES: readonly Rule[] = [
  { name: "read_document", when: recent => /\.(docx|xlsx|pptx|pdf)\b/i.test(recent.user) || /\.(docx|xlsx|pptx)\b/i.test(recent.text.slice(-1500)), why: "read Word, Excel, PowerPoint or PDF files as text (the read tool cannot open Office files)" },
  { name: "reminder", when: has(/\b(check (back|on it|again|in)|later\b|in (a|an|\d+|a few) (min|minute|hour)|takes? (about |around |roughly )?(\d+|a few|several)|wait (for|until)|when it(’|'| i)s? (done|finished|ready)|once it (finishes|is done)|keep an eye|follow up|tomorrow)/i), why: "set a timer and end your turn instead of waiting, polling or sleeping in the shell; you are woken with your message" },
  { name: "library_search", when: has(/\b(cite|citation|quote|quotation|reference(s)? for|according to|exact wording|which page|what does (the|a) (standard|paper|book|manual|guideline) say|source for)\b/i), why: "check exact wording, numbers or syntax in the reference library and cite the section it returns" },
  { name: "search_project", when: has(/\b(where (is|are|do|does|did)|which (file|module|function|class)|find (the|where|all)|locate|look for the code|how does .{3,60} work in (this|the) (project|repo|codebase))\b/i), why: "find where something is described or implemented when you don't know the exact words" },
  { name: "terminal_read", when: has(/\b(my terminal|the terminal|terminal (tab|window)|in the review pane|what('s| is) (running|happening) in)\b/i), why: "read what the user's shared terminal shows (and terminal_write to type into it)" },
  { name: "task_handoff", when: has(/\b(hand ?off|handover|colleague|someone else (can|will)|pick (this|it) up (tomorrow|later)|continue (this )?(tomorrow|next week))\b/i), why: "write the task notes to a handoff file in the project that someone else can continue from" },
  { name: "skill:pixi", when: has(/\b(pip install|virtualenv|venv|conda (create|install)|uv (add|pip|run)|requirements\.txt|set up (a|the) (python )?(environment|env|toolchain))\b/i), why: "load the pixi skill: environments for scripts and projects in any language" },
]

const WORDS = (text: string) => new Set(text.toLowerCase().match(/[a-z][a-z0-9+-]{3,}/g) ?? [])
const GENERIC = new Set("use when load before work with this that from your into make about other only also each more them they then their what which have will should could would using used uses".split(" "))

/** Cues by rules only: cheap, predictable, for the moments that are easy to recognize. */
export function ruleCues(index: readonly Capability[], recent: Recent): Cue[] {
  const available = new Set(index.map(item => item.name))
  const cues: Cue[] = RULES.filter(rule => available.has(rule.name) && !recent.used.has(rule.name) && rule.when(recent)).map(rule => ({ name: rule.name, why: rule.why, source: "rule" as const }))
  // A skill whose name, or several distinctive words of its description, appear in the user's message.
  if (recent.user) {
    const said = WORDS(recent.user)
    const lower = recent.user.toLowerCase()
    for (const skill of index.filter(item => item.kind === "skill" && !recent.used.has(item.name) && !cues.some(cue => cue.name === item.name))) {
      const name = skill.name.slice("skill:".length)
      // A plain word ("report", "browser") is only a cue when the user asks to use it ("with gnuplot", "the pixi
      // skill"); distinctive names (with a hyphen or digit, e.g. "ml-metrics") count when mentioned at all.
      const pattern = name.replace(/[-_]/g, "[- _]?")
      const distinctive = /[-_\d]/.test(name)
      const named = name.length > 3 && (distinctive ? new RegExp(`\\b${pattern}\\b`, "i").test(lower) : new RegExp(`\\b(${pattern} skill|skill ${pattern}|(with|using|use|via) (the )?${pattern})\\b(?![.\\w])`, "i").test(lower))
      const overlap = [...WORDS(skill.summary)].filter(word => word.length >= 5 && !GENERIC.has(word) && said.has(word)).length
      if (named || overlap >= 3) cues.push({ name: skill.name, why: `load the ${name} skill: ${skill.summary.slice(0, 120)}`, source: "rule" })
    }
  }
  return cues.slice(0, 4)
}

/** The tail message the agent sees. */
export function cueText(cues: readonly Cue[]): string {
  return `Top of mind for this step (oc-enhance; only if useful, ignore otherwise):\n${cues.map(cue => `- ${cue.name.startsWith("skill:") ? `skill ${cue.name.slice(6)}` : cue.name}: ${cue.why}`).join("\n")}`
}

/** The prompt for the fast model (any chat model the user picked; it only ranks, it never acts). */
export function modelPrompt(index: readonly Capability[], recent: Recent): string {
  return [
    "You help a coding agent remember its capabilities in a long session. Below are the capabilities it has and the latest part of the conversation.",
    "Never pick save_task_notes (it has its own reminder). Pick at most 3 capabilities that the agent will probably need in its NEXT steps and might forget or misuse (e.g. using sleep instead of a reminder, reading a .docx with the plain read tool, answering a citation question from memory, not loading a relevant skill). Do not pick basic tools the agent obviously uses already (read, edit, shell, grep, glob, write). Pick none if nothing stands out.",
    'Answer with JSON only: {"cues": [{"name": "<exact capability name>", "why": "<under 20 words, specific to this moment>"}]}',
    "",
    "Capabilities:",
    ...index.slice(0, 150).map(item => `- ${item.name}: ${item.summary}`),
    "",
    `Already used since the user's latest message: ${[...recent.used].join(", ") || "nothing"}`,
    "Conversation (latest last):",
    recent.text.slice(-4000),
  ].join("\n")
}

export function parseModelCues(text: string, index: readonly Capability[]): Cue[] {
  const start = text.indexOf("{"), end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return []
  let value: { cues?: unknown }
  try { value = JSON.parse(text.slice(start, end + 1)) } catch { return [] }
  const names = new Set(index.map(item => item.name))
  // Basic tools, and ones with their own reminders (notes), are never cues.
  const basic = new Set(["read", "edit", "write", "shell", "bash", "grep", "glob", "webfetch", "websearch", "question", "save_task_notes", "todowrite"])
  return (Array.isArray(value.cues) ? value.cues : []).flatMap(item => {
    const cue = item as { name?: unknown; why?: unknown }
    let name = typeof cue.name === "string" ? cue.name.trim() : ""
    if (!names.has(name) && names.has(`skill:${name}`)) name = `skill:${name}`
    if (!names.has(name) || basic.has(name) || typeof cue.why !== "string" || !cue.why.trim()) return []
    return [{ name, why: cue.why.trim().replace(/\s+/g, " ").slice(0, 160), source: "model" as const }]
  }).slice(0, 3)
}

export interface ModelRef { readonly providerID: string; readonly id: string }
export const parseModelRef = (value: string | undefined): ModelRef | undefined => {
  const match = /^([^/\s]+)\/(\S+)$/.exec(value?.trim() ?? "")
  return match ? { providerID: match[1]!, id: match[2]! } : undefined
}

interface SessionState {
  /** Which user message the cues and counts belong to. */
  key: string
  shown: Map<string, number>
  model?: { cues: Cue[]; key: string; calls: number; at: number }
  pending?: boolean
  last?: { cues: Cue[]; at: number }
}

const GLOBAL = Symbol.for("oc-enhance.topofmind.v1")
const sessions: Map<string, SessionState> = ((globalThis as Record<symbol, unknown>)[GLOBAL] ??= new Map()) as Map<string, SessionState>

export interface TopOfMindHost {
  /** Asks the fast model; resolves with its text. */
  generate(model: ModelRef, prompt: string): Promise<string>
  warn(message: string, error?: unknown): void
}

export class TopOfMind {
  constructor(private readonly host: TopOfMindHost, private readonly now = () => Date.now()) {}

  /**
   * The cues for this request (synchronous apart from reading state; the model, if any, is asked in the background and
   * its answer is used from the next request on).
   */
  cues(sessionID: string, index: readonly Capability[], recent: Recent, model?: ModelRef): Cue[] {
    const key = `${recent.user.length}:${recent.user.slice(0, 200)}`
    let state = sessions.get(sessionID)
    if (!state || state.key !== key) sessions.set(sessionID, state = { key, shown: new Map(), ...(state?.model && { model: state.model }) })
    if (model) this.#refresh(sessionID, state, index, recent, model, key)
    const merged = new Map<string, Cue>()
    for (const cue of ruleCues(index, recent)) merged.set(cue.name, cue)
    const fromModel = state.model && (state.model.key === key || recent.calls - state.model.calls <= 6) ? state.model.cues : []
    for (const cue of fromModel) if (!merged.has(cue.name) && !recent.used.has(cue.name)) merged.set(cue.name, cue)
    const chosen = [...merged.values()].filter(cue => (state!.shown.get(cue.name) ?? 0) < 2).slice(0, 3)
    for (const cue of chosen) state.shown.set(cue.name, (state.shown.get(cue.name) ?? 0) + 1)
    if (chosen.length) state.last = { cues: chosen, at: this.now() }
    return chosen
  }

  /** What the session was last reminded of (for the Pause panel). */
  last(sessionID: string) { return sessions.get(sessionID)?.last }

  #refresh(sessionID: string, state: SessionState, index: readonly Capability[], recent: Recent, model: ModelRef, key: string) {
    // Ask again for a new user message, or every 6 tool calls; one request at a time per session.
    if (state.pending || (state.model && state.model.key === key && recent.calls - state.model.calls < 6)) return
    state.pending = true
    const calls = recent.calls
    void this.host.generate(model, modelPrompt(index, recent))
      .then(text => { state.model = { cues: parseModelCues(text, index), key, calls, at: this.now() } })
      .catch(error => { this.host.warn("top-of-mind model failed; using rules only", error); state.model = { cues: [], key, calls, at: this.now() } })
      .finally(() => { state.pending = false })
  }
}
