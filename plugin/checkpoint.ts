import type { Context } from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { Session } from "@opencode/schema/session"
import { createHash } from "node:crypto"

const KEY = "checkpoints/v1"
const INSTRUCTIONS = "Maintain open_enhance_checkpoint at task start and meaningful boundaries: concise origin (original objective), current (observable progress), next (next safe action), decisions, and workspace-relative paths. Never include chain-of-thought, secrets, source contents, tool arguments or results. These are agent-maintained notes, not verified facts. After interruption, reconcile workspace moves, edits and external effects using native permission-checked tools; never blindly rerun unknown operations. Ordinary messages never resume a paused session."
type Notes = { origin: string; current: string; next: string; decisions: string[]; paths: string[] }
type Entry = Notes & { id: string; parentID?: string; workspace: string; paused: boolean; interruptFailures?: string[] }
type Journal = { session: string; call: string; tool: string; outcome: "pending" | "completed" | "error" | "unknown"; acknowledged: boolean; startedAt: number; settledAt?: number }
type State = { version: 1; revision: number; sessions: Entry[]; journal: Journal[] }
export type ResumeInput = { revision: number; reconciliation: string; acknowledgeUnknown: boolean }
export type CheckpointStatus = State & { state: "running" | "paused" | "unknown" | "needs-reconciliation"; blockedBy: string[]; reconciliationRequired: true; workspaceChanged: boolean }
export interface CheckpointController {
  pause(sessionID: string): Promise<{ status: CheckpointStatus; interruptFailures: string[] }>
  resume(sessionID: string, input?: ResumeInput): Promise<CheckpointStatus>
  status(sessionID: string): Promise<CheckpointStatus>
  forget(sessionID: string): Promise<void>
  dispose(): Promise<void>
}
// OpenCode gives each location a different storage wrapper over the SAME plugin
// KV namespace. Serialize by process-wide plugin identity, not wrapper identity.
const coordinationKey = Symbol.for("open-enhance.checkpoints.v1.coordination")
const global = globalThis as typeof globalThis & { [coordinationKey]?: { queue: Promise<unknown>; active: Set<string>; pausing: Set<string> } }
const coordination = global[coordinationKey] ??= { queue: Promise.resolve(), active: new Set<string>(), pausing: new Set<string>() }
function serial<T>(_storage: object, fn: () => Promise<T>): Promise<T> {
  const result = coordination.queue.catch(() => {}).then(fn)
  coordination.queue = result.then(() => {}, () => {})
  return result
}
function object(x: unknown): x is Record<string, unknown> { return !!x && typeof x === "object" && !Array.isArray(x) }
function exact(x: Record<string, unknown>, keys: string[], optional: string[] = []) { if (Object.keys(x).some(k => !keys.includes(k) && !optional.includes(k)) || keys.some(k => !(k in x))) throw new Error("Invalid checkpoint fields") }
function text(x: unknown, max = 1000): asserts x is string { if (typeof x !== "string" || x.length > max || /[\u0000-\u0008\u000b-\u001f]/.test(x)) throw new Error("Invalid checkpoint text") }
function id(x: unknown): asserts x is string { text(x, 200); if (!x || !/^[a-zA-Z0-9_.:-]+$/.test(x)) throw new Error("Invalid checkpoint identifier") }
function notes(x: unknown): Notes {
  if (!object(x)) throw new Error("Invalid checkpoint notes")
  exact(x, ["origin", "current", "next", "decisions", "paths"])
  for (const k of ["origin", "current", "next"]) text(x[k])
  if (!Array.isArray(x.decisions) || x.decisions.length > 12 || !Array.isArray(x.paths) || x.paths.length > 32) throw new Error("Checkpoint bounds exceeded")
  x.decisions.forEach(v => text(v, 300))
  x.paths.forEach(v => { text(v, 300); if (!v || v.startsWith("/") || v.includes("\\") || v.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Checkpoint paths must be relative") })
  return structuredClone(x) as Notes
}
function decode(x: unknown): State {
  if (x === undefined) return { version: 1, revision: 0, sessions: [], journal: [] }
  if (!object(x)) throw new Error("Invalid checkpoint storage")
  exact(x, ["version", "revision", "sessions", "journal"])
  if (x.version !== 1 || !Number.isSafeInteger(x.revision) || Number(x.revision) < 0 || !Array.isArray(x.sessions) || x.sessions.length > 256 || !Array.isArray(x.journal) || x.journal.length > 256) throw new Error("Invalid checkpoint storage")
  const seen = new Set<string>()
  for (const s of x.sessions) {
    if (!object(s)) throw new Error("Invalid checkpoint session")
    exact(s, ["id", "workspace", "paused", "origin", "current", "next", "decisions", "paths", ...("parentID" in s ? ["parentID"] : []), ...("interruptFailures" in s ? ["interruptFailures"] : [])])
    if ("parentID" in s) id(s.parentID)
    if ("interruptFailures" in s) { if (!Array.isArray(s.interruptFailures) || s.interruptFailures.length > 256) throw new Error("Invalid interruption failures"); s.interruptFailures.forEach(id) }
    id(s.id); if (seen.has(s.id)) throw new Error("Duplicate checkpoint session"); seen.add(s.id)
    if (typeof s.workspace !== "string" || !/^[a-f0-9]{64}$/.test(s.workspace) || typeof s.paused !== "boolean") throw new Error("Invalid checkpoint session")
    notes({ origin: s.origin, current: s.current, next: s.next, decisions: s.decisions, paths: s.paths })
  }
  const calls = new Set<string>()
  for (const j of x.journal) {
    if (!object(j)) throw new Error("Invalid checkpoint journal")
    exact(j, ["session", "call", "tool", "outcome", "acknowledged", "startedAt"], ["settledAt"])
    id(j.session); id(j.call); id(j.tool)
    if (!Number.isSafeInteger(j.startedAt) || Number(j.startedAt) < 0 || (j.settledAt !== undefined && (!Number.isSafeInteger(j.settledAt) || Number(j.settledAt) < Number(j.startedAt)))) throw new Error("Invalid journal timestamps")
    if ((j.outcome === "completed" || j.outcome === "error") !== (j.settledAt !== undefined)) throw new Error("Invalid journal settlement")
    if (!seen.has(j.session) || calls.has(`${j.session}/${j.call}`) || !["pending", "completed", "error", "unknown"].includes(String(j.outcome)) || typeof j.acknowledged !== "boolean" || (j.acknowledged && j.outcome !== "unknown")) throw new Error("Invalid checkpoint journal")
    calls.add(`${j.session}/${j.call}`)
  }
  return structuredClone(x) as State
}

/** Opt-in only. Location controllers coordinate writes to the server's shared KV. */
export async function installCheckpoints(ctx: Context): Promise<CheckpointController | undefined> {
  if (ctx.options.checkpoints !== true) return
  let disposed = false, failed = false, initialized = false
  const pausing = coordination.pausing
  const ownedCalls = new Set<string>()
  const registrations: Registration[] = []
  const sid = (value: string) => { id(value); return value as Session.ID }
  const read = async () => {
    let value
    try { value = await ctx.storage.get(KEY) } catch (error) { failed = true; throw error }
    if (initialized && value === undefined) throw new Error("Checkpoint storage disappeared; fail closed")
    return decode(value)
  }
  const save = async (state: State) => { state.revision++; try { await ctx.storage.set(KEY, state) } catch (e) { failed = true; throw e } }
  const run = <T>(fn: (state: State) => Promise<T>) => serial(ctx.storage, async () => {
    if (disposed) throw new Error("Checkpoints disposed")
    if (failed) throw new Error("Checkpoint storage failed; fail-closed until plugin reload")
    try { return await fn(await read()) } catch (e) {
      if (failed) { for (const call of ownedCalls) coordination.active.delete(call); ownedCalls.clear() }
      throw e
    }
  })
  const ancestry = async (sessionID: string) => {
    const result: string[] = []
    let current: string | undefined = sessionID
    while (current) {
      if (result.length >= 64 || result.includes(current)) throw new Error("Invalid session ancestry")
      result.push(current)
      const session = await ctx.session.get({ sessionID: sid(current) })
      if (session.parentID !== undefined) id(session.parentID)
      current = session.parentID
    }
    return result
  }
  const ensure = async (state: State, sessionID: string, visited = new Set<string>()): Promise<Entry> => {
    let entry = state.sessions.find(s => s.id === sessionID)
    if (!entry) {
      if (visited.has(sessionID) || visited.size >= 64) throw new Error("Invalid session ancestry")
      visited.add(sessionID)
      const session = await ctx.session.get({ sessionID: sid(sessionID) })
      // Persist intermediate ancestry even when only a grandchild has emitted
      // tool events. Otherwise scoped status could omit its unresolved work.
      if (session.parentID) { id(session.parentID); await ensure(state, session.parentID, visited) }
      if (state.sessions.length >= 256) throw new Error("Checkpoint session retention full; explicit maintenance required")
      entry = { id: sessionID, ...(session.parentID ? { parentID: session.parentID } : {}), workspace: createHash("sha256").update(session.location.directory).digest("hex"), paused: false, origin: "", current: "", next: "", decisions: [], paths: [] }
      state.sessions.push(entry)
    }
    return entry
  }
  const blocked = (state: State, chain: string[]) => chain.filter(id => state.sessions.some(s => s.id === id && s.paused) || state.journal.some(j => j.session === id && ((j.outcome === "unknown" && !j.acknowledged) || (j.outcome === "pending" && !coordination.active.has(`${j.session}/${j.call}`)))))
  const gate = async (state: State, sessionID: string) => { if (blocked(state, await ancestry(sessionID)).length) throw new Error("Checkpoint paused/unknown effects: use enhance-status and explicit enhance-resume after reconciliation") }
  const descendants = (state: State, sessionID: string) => {
    const related = new Set([sessionID])
    let changed = true
    while (changed) {
      changed = false
      for (const entry of state.sessions) if (entry.parentID && related.has(entry.parentID) && !related.has(entry.id)) { related.add(entry.id); changed = true }
    }
    return related
  }
  const status = async (state: State, sessionID: string): Promise<CheckpointStatus> => {
    const chain = await ancestry(sessionID)
    const blockedBy = blocked(state, chain)
    const session = await ctx.session.get({ sessionID: sid(sessionID) })
    const entry = state.sessions.find(s => s.id === sessionID)
    const workspaceChanged = !!entry && entry.workspace !== createHash("sha256").update(session.location.directory).digest("hex")
    const related = descendants(state, sessionID)
    chain.forEach(id => related.add(id))
    const sessions = structuredClone(state.sessions.filter(s => related.has(s.id)))
    const journal = structuredClone(state.journal.filter(j => related.has(j.session)))
    // A form's revision must not expire because an unrelated session made a tool
    // call. Hash only the state this user is being asked to reconcile.
    const revision = Number.parseInt(createHash("sha256").update(JSON.stringify({ sessions, journal, blockedBy, workspaceChanged })).digest("hex").slice(0, 12), 16)
    return { version: 1, revision, sessions, journal, state: blockedBy.length ? state.sessions.some(s => blockedBy.includes(s.id) && s.paused) ? "paused" : "unknown" : "running", blockedBy, reconciliationRequired: true, workspaceChanged }
  }
  // Pending at startup is not evidence of failure or completion. Never replay it.
  await run(async state => {
    let changed = false
    for (const j of state.journal) if (j.outcome === "pending" && !coordination.active.has(`${j.session}/${j.call}`)) { j.outcome = "unknown"; changed = true }
    if (changed || state.revision === 0) await save(state)
    initialized = true
  })
  const controller: CheckpointController = {
    status: sessionID => run(state => status(state, sessionID)),
    forget: sessionID => run(async state => {
      await gate(state, sessionID)
      const targets = descendants(state, sessionID)
      if (state.sessions.some(entry => targets.has(entry.id) && entry.paused) ||
          state.journal.some(entry => targets.has(entry.session) && (entry.outcome === "pending" || (entry.outcome === "unknown" && !entry.acknowledged)))) {
        throw new Error("Cannot forget paused or unresolved work")
      }
      state.sessions = state.sessions.filter(entry => !targets.has(entry.id))
      state.journal = state.journal.filter(entry => !targets.has(entry.session))
      await save(state)
    }),
    pause: async sessionID => {
      const prepared = await run(async state => {
        if (pausing.has(sessionID)) throw new Error("Pause interruption still in progress")
        const root = await ensure(state, sessionID)
        root.paused = true
        root.interruptFailures = []
        // Commit the ancestor gate BEFORE enumeration or any interrupt RPC.
        await save(state)
        const targets = new Set([sessionID])
        const failures: string[] = []
        let pages = 0
        try {
          for (const parent of targets) {
            let cursor: NonNullable<Parameters<Context["session"]["list"]>[0]>["cursor"]
            do {
              if (++pages > 512) throw new Error("Unbounded child pagination")
              const page = await ctx.session.list({ parentID: sid(parent), limit: 100, ...(cursor ? { cursor } : {}) })
              for (const child of page.data) {
                id(child.id)
                if (child.parentID !== parent || targets.has(child.id) || targets.size >= 256) throw new Error("Invalid/unbounded child tree")
                targets.add(child.id)
              }
              const next = page.cursor.next
              if (next && next === cursor) throw new Error("Repeated child cursor")
              cursor = next ?? undefined
            } while (cursor)
          }
        } catch { failures.push("descendant-enumeration") }
        for (const j of state.journal) if (targets.has(j.session) && j.outcome === "pending") j.outcome = "unknown"
        await save(state)
        pausing.add(sessionID)
        return { targets, failures }
      })
      const { targets, failures } = prepared
      try {
        const results = await Promise.allSettled([...targets].map(async target => { await ctx.session.interrupt({ sessionID: sid(target), resume: false }) }))
        results.forEach((r, i) => { if (r.status === "rejected") failures.push([...targets][i]) })
        await run(async state => {
          const entry = await ensure(state, sessionID)
          entry.interruptFailures = failures
          await save(state)
        })
      } finally { pausing.delete(sessionID) }
      return { status: await controller.status(sessionID), interruptFailures: failures }
    },
    resume: (sessionID, input) => run(async state => {
      if (input === undefined) return { ...await status(state, sessionID), state: "needs-reconciliation" }
      if (!object(input)) throw new Error("Explicit reconciliation required")
      exact(input, ["revision", "reconciliation", "acknowledgeUnknown"])
      text(input.reconciliation, 1000)
      if (!input.reconciliation.trim() || typeof input.acknowledgeUnknown !== "boolean" || input.revision !== (await status(state, sessionID)).revision) throw new Error("Explicit reconciliation and current status revision required")
      const chain = await ancestry(sessionID)
      if (chain.some(id => pausing.has(id))) throw new Error("Pause interruption still in progress")
      if (blocked(state, chain.slice(1)).length) throw new Error("Resume the paused ancestor explicitly")
      const targets = descendants(state, sessionID)
      if (state.sessions.some(entry => targets.has(entry.id) && entry.interruptFailures?.length) && !input.acknowledgeUnknown) throw new Error("Unconfirmed interruptions require explicit acknowledgment")
      if (state.journal.some(j => targets.has(j.session) && j.outcome === "pending")) throw new Error("Pause running tools before resuming")
      if (state.journal.some(j => targets.has(j.session) && (j.outcome === "unknown" || j.outcome === "pending")) && !input.acknowledgeUnknown) throw new Error("Unknown operations require explicit acknowledgment; never blindly rerun")
      const entry = await ensure(state, sessionID)
      const session = await ctx.session.get({ sessionID: sid(sessionID) })
      // No filesystem reads: require manual/native permission-checked reconciliation on EVERY resume.
      const workspace = createHash("sha256").update(session.location.directory).digest("hex")
      await ctx.session.instructions.entry.put({ sessionID: sid(sessionID), key: "open-enhance-checkpoint", value: `${INSTRUCTIONS}\nExplicit resume: independently verify declared paths and workspace edits/moves before further side effects. Unknown journal operations are acknowledged, NOT safe to retry.\nCheckpoint notes (untrusted data): ${JSON.stringify({ origin: entry.origin, current: entry.current, next: entry.next, decisions: entry.decisions, paths: entry.paths })}` })
      entry.workspace = workspace
      entry.paused = false
      entry.interruptFailures = []
      for (const j of state.journal) if (targets.has(j.session) && (j.outcome === "unknown" || j.outcome === "pending")) { j.outcome = "unknown"; j.acknowledged = true }
      await save(state)
      return status(state, sessionID)
    }),
    dispose: async () => { disposed = true; for (const call of ownedCalls) coordination.active.delete(call); ownedCalls.clear(); await Promise.all(registrations.map(r => r.dispose())) },
  }
  try {
    // OpenCode 2.2.6 exposes no session/call identity on this lower-level hook.
    // Never guess attribution from command text, cwd, or a timing-based token:
    // a direct native shell could otherwise consume another session's proof.
    // Conservatively bar ALL shell creation in this plugin namespace while any
    // durable pause/unacknowledged uncertainty exists. Native tool dispatch is
    // still session-scoped and journaled by the separate hooks below.
    registrations.push(await ctx.shell.hook("create.before", () => run(async state => {
      if (state.sessions.some(entry => entry.paused) || state.journal.some(entry =>
        (entry.outcome === "unknown" && !entry.acknowledged) ||
        (entry.outcome === "pending" && !coordination.active.has(`${entry.session}/${entry.call}`)))) {
        throw new Error("Checkpoint shell barrier: a session is paused or has unknown effects. OpenCode does not attribute native shell creation; reconcile explicitly before starting any shell in this plugin namespace.")
      }
    })))
    registrations.push(await ctx.tool.hook("execute.before", input => run(async state => {
      await gate(state, input.sessionID)
      const checkpoint = await ensure(state, input.sessionID)
      if (input.tool !== "open_enhance_checkpoint" && (!checkpoint.origin.trim() || !checkpoint.current.trim() || !checkpoint.next.trim())) throw new Error("Maintain a nonempty origin/current/next with open_enhance_checkpoint before any other tool dispatch")
      id(input.id); id(input.tool)
      if (state.journal.some(j => j.session === input.sessionID && j.call === input.id)) throw new Error("Duplicate tool call: explicit reconciliation required")
      // Evict only settled records; never lose pending/unknown operations.
      if (state.journal.length >= 256) {
        const index = state.journal.findIndex(j => j.outcome === "completed" || j.outcome === "error" || j.acknowledged)
        if (index < 0) throw new Error("Checkpoint journal full of unresolved operations")
        state.journal.splice(index, 1)
      }
      state.journal.push({ session: input.sessionID, call: input.id, tool: input.tool, outcome: "pending", acknowledged: false, startedAt: Date.now() })
      await save(state)
      const key = `${input.sessionID}/${input.id}`
      coordination.active.add(key); ownedCalls.add(key)
    })))
    registrations.push(await ctx.tool.hook("execute.after", input => run(async state => {
      const entry = state.journal.find(j => j.session === input.sessionID && j.call === input.id)
      if (!entry) return // A denied before hook did not dispatch.
      entry.outcome = input.status; entry.acknowledged = false
      entry.settledAt = Math.max(entry.startedAt, Date.now())
      await save(state)
      const key = `${input.sessionID}/${input.id}`
      coordination.active.delete(key); ownedCalls.delete(key)
    })))
    registrations.push(await ctx.session.hook("prompt", input => run(state => gate(state, input.sessionID))))
    registrations.push(await ctx.session.hook("context", input => run(async state => {
      await gate(state, input.sessionID)
      const checkpoint = state.sessions.find(entry => entry.id === input.sessionID)
      const initializedNotes = checkpoint?.origin.trim() && checkpoint.current.trim() && checkpoint.next.trim()
      if (input.tools && !Object.hasOwn(input.tools, "open_enhance_checkpoint") && !initializedNotes) {
        throw new Error("Checkpoint initialization is unavailable: this agent's native tool permissions do not expose open_enhance_checkpoint. Explicitly authorize that maintenance tool or disable checkpoints for this configuration; the plugin never grants permissions automatically.")
      }
      input.system.push({ type: "text", text: INSTRUCTIONS })
    })))
    registrations.push(await ctx.tool.transform(editor => editor.add({
      name: "open_enhance_checkpoint", description: INSTRUCTIONS, options: { codemode: false },
      input: { type: "object", properties: { origin: { type: "string", maxLength: 1000 }, current: { type: "string", maxLength: 1000 }, next: { type: "string", maxLength: 1000 }, decisions: { type: "array", maxItems: 12, items: { type: "string", maxLength: 300 } }, paths: { type: "array", maxItems: 32, items: { type: "string", maxLength: 300 } } }, required: ["origin", "current", "next", "decisions", "paths"], additionalProperties: false },
      execute: (input, context) => run(async state => {
        await gate(state, context.sessionID) // Fresh durable read, even for captured executors.
        const update = notes(input), entry = await ensure(state, context.sessionID)
        if (!update.origin.trim() || !update.current.trim() || !update.next.trim()) throw new Error("Checkpoint origin/current/next must be nonempty")
        if (entry.origin && update.origin !== entry.origin) throw new Error("Original objective is immutable; start a new session for a new objective")
        Object.assign(entry, update)
        await save(state)
        return { content: "Checkpoint updated", metadata: { feature: "checkpoints" } }
      }),
    })))
    registrations.push(await ctx.command.transform(editor => {
      editor.add({ name: "enhance-forget", description: "Forget settled checkpoint notes for this session tree; requires confirm", execute: async ({ sessionID, prompt }) => {
        if (prompt.text.trim() !== "confirm") throw new Error("Use enhance-forget confirm to explicitly remove settled checkpoint history")
        await controller.forget(sessionID)
        await ctx.session.instructions.entry.remove({ sessionID, key: "open-enhance-checkpoint" })
        await ctx.session.instructions.entry.remove({ sessionID, key: "open-enhance-checkpoint-status" })
      } })
      editor.add({ name: "enhance-pause", description: "Persist pause gate, then interrupt session tree", execute: async ({ sessionID }) => { const result = await controller.pause(sessionID); await ctx.session.instructions.entry.put({ sessionID, key: "open-enhance-checkpoint-status", value: JSON.stringify(result) }) } })
      editor.add({ name: "enhance-status", description: "Show checkpoint status as session context", execute: async ({ sessionID }) => { await ctx.session.instructions.entry.put({ sessionID, key: "open-enhance-checkpoint-status", value: JSON.stringify(await controller.status(sessionID)) }) } })
      editor.add({ name: "enhance-resume", description: "Explicit resume: JSON revision, reconciliation, acknowledgeUnknown; no arguments only requests review", execute: async ({ sessionID, prompt }) => {
        const result = await controller.resume(sessionID, prompt.text.trim() ? JSON.parse(prompt.text) : undefined)
        await ctx.session.instructions.entry.put({ sessionID, key: "open-enhance-checkpoint-status", value: JSON.stringify(result) })
      } })
    }))
    return controller
  } catch (error) { await controller.dispose(); throw error }
}
