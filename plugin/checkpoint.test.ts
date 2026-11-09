import test from "node:test"
import assert from "node:assert/strict"
import { installCheckpoints } from "./checkpoint.js"
import type { Context } from "@opencode/plugin/promise/plugin"

function harness() {
  const db = new Map<string, unknown>()
  const hooks = new Map<string, (input: any) => Promise<void>>()
  const tools = new Map<string, any>(), commands = new Map<string, any>()
  const sessions = new Map<string, any>([["root", { id: "root", location: { directory: "/synthetic/workspace" } }]])
  const instructions = new Map<string, string>(), interrupted: string[] = []
  let failRead = false, failWrite = false, failInterrupt = false
  const ctx = {
    options: { checkpoints: true },
    storage: {
      get: async (key: string) => { if (failRead) throw new Error("read failed"); return structuredClone(db.get(key)) },
      set: async (key: string, value: unknown) => { if (failWrite) throw new Error("write failed"); db.set(key, structuredClone(value)) },
    },
    session: {
      get: async ({ sessionID }: any) => { if (!sessions.has(sessionID)) throw new Error("missing session"); return sessions.get(sessionID) },
      list: async ({ parentID }: any) => ({ data: [...sessions.values()].filter(s => s.parentID === parentID), cursor: {} }),
      interrupt: async ({ sessionID, resume }: any) => { assert.equal(resume, false); assert.equal((db.get("checkpoints/v1") as any).sessions.find((s: any) => s.id === "root").paused, true); interrupted.push(sessionID); if (failInterrupt) throw new Error("interrupt failed"); return { interrupted: true } },
      instructions: { entry: { put: async ({ sessionID, key, value }: any) => { instructions.set(`${sessionID}/${key}`, value) } } },
      hook: async (name: string, callback: any) => { hooks.set(`session/${name}`, callback); return { dispose: async () => { hooks.delete(`session/${name}`) } } },
    },
    tool: {
      hook: async (name: string, callback: any) => { hooks.set(`tool/${name}`, callback); return { dispose: async () => { hooks.delete(`tool/${name}`) } } },
      transform: async (callback: any) => { callback({ add: (tool: any) => tools.set(tool.name, tool) }); return { dispose: async () => {} } },
    },
    shell: { hook: async (name: string, callback: any) => { hooks.set(`shell/${name}`, callback); return { dispose: async () => { hooks.delete(`shell/${name}`) } } } },
    command: { transform: async (callback: any) => { callback({ add: (command: any) => commands.set(command.name, command) }); return { dispose: async () => {} } } },
  } as unknown as Context
  const invoke = (kind: string, input: any) => hooks.get(kind)!(input)
  const before = (call: string, sessionID = "root", tool = "shell") => invoke("tool/execute.before", { sessionID, id: call, tool, input: { secret: "NOT-PERSISTED" } })
  const after = (call: string, sessionID = "root", status = "completed") => invoke("tool/execute.after", { sessionID, id: call, tool: "shell", status, result: { content: "NOT-PERSISTED" } })
  const update = (input: unknown, sessionID = "root") => tools.get("open_enhance_checkpoint").execute(input, { sessionID })
  return { ctx, db, hooks, tools, commands, sessions, instructions, interrupted, invoke, before, after, update, fail: (kind: string, value: boolean) => { if (kind === "read") failRead = value; if (kind === "write") failWrite = value; if (kind === "interrupt") failInterrupt = value } }
}
test("distinct location storage wrappers serialize shared namespace without losing pause", async () => {
  const a = harness()
  const b = harness()
  b.sessions.set("other", { id: "other", location: { directory: "/synthetic/other" } })
  const shared = a.ctx.storage
  Object.assign(b.ctx.storage, {
    get: async (key: string) => { await new Promise(resolve => setTimeout(resolve, 2)); return shared.get(key) },
    set: async (key: string, value: Parameters<typeof shared.set>[1]) => { await new Promise(resolve => setTimeout(resolve, 2)); await shared.set(key, value) },
  })
  const first = (await installCheckpoints(a.ctx))!
  await a.update(notes)
  await a.before("active-root")
  const second = (await installCheckpoints(b.ctx))!
  assert.equal((await first.status("root")).journal[0].outcome, "pending", "loading another location must not classify a live call as crashed")
  await Promise.all([first.pause("root"), b.update({ ...notes, origin: "Unrelated work" }, "other")])
  const stored = a.db.get("checkpoints/v1") as any
  assert.equal(stored.sessions.find((entry: any) => entry.id === "root").paused, true)
  assert.ok(stored.sessions.some((entry: any) => entry.id === "other"))
  await assert.rejects(a.before("blocked"), /paused/)
  await first.dispose(); await second.dispose()
})
test("deleted unrelated history cannot poison status or reopen a failed resume", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  h.sessions.set("deleted", { id: "deleted", location: { directory: "/synthetic/deleted" } })
  await h.update(notes)
  await h.update({ ...notes, origin: "Old task" }, "deleted")
  h.sessions.delete("deleted")
  await c.pause("root")
  const status = await c.status("root")
  assert.deepEqual(status.sessions.map(entry => entry.id), ["root"])
  await c.resume("root", { revision: status.revision, reconciliation: "Reviewed current task", acknowledgeUnknown: false })
  assert.deepEqual((await c.status("root")).blockedBy, [])
})
const notes = { origin: "Synthetic objective", current: "Prepared", next: "Inspect", decisions: ["Keep native permissions"], paths: ["src/example.ts"] }

test("unattributed native shell creation fails closed across the shared namespace while paused", async () => {
  const h = harness(), controller = (await installCheckpoints(h.ctx))!
  const create = () => h.invoke("shell/create.before", { command: "touch synthetic-marker", cwd: "/synthetic/elsewhere" })
  await create()
  await h.update(notes)
  await controller.pause("root")
  await assert.rejects(create(), /Checkpoint shell barrier/)
  const status = await controller.status("root")
  await controller.resume("root", { revision: status.revision, reconciliation: "Reviewed synthetic task and unrelated shell boundary", acknowledgeUnknown: false })
  await create()
  await h.before("uncertain")
  await controller.dispose()
  const reloaded = (await installCheckpoints(h.ctx))!
  await assert.rejects(create(), /Checkpoint shell barrier/)
  assert.equal((await reloaded.status("root")).journal[0].outcome, "unknown")
  await reloaded.dispose()
})

test("strict opt-in has no storage or registrations", async () => {
  assert.equal(await installCheckpoints({ options: {} } as Context), undefined)
})
test("an unavailable maintenance tool fails before model dispatch instead of an initialization loop", async () => {
  const h = harness(), controller = (await installCheckpoints(h.ctx))!
  await assert.rejects(h.invoke("session/context", { sessionID: "root", tools: { read: {} }, system: [] }), /native tool permissions do not expose open_enhance_checkpoint/)
  const input = { sessionID: "root", tools: { open_enhance_checkpoint: {} }, system: [] as unknown[] }
  await h.invoke("session/context", input)
  assert.equal(input.system.length, 1)
  await h.update(notes)
  // Native step limits remove tools for a final summary. Existing notes must
  // not turn that native read-only completion into an initialization error.
  await h.invoke("session/context", { sessionID: "root", tools: {}, system: [] })
  await controller.dispose()
})
test("durable before-dispatch journal, bounded notes and observed outcomes", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.update(notes)
  await h.before("call1")
  assert.equal((await c.status("root")).journal[0].outcome, "pending")
  await h.after("call1")
  const state = await c.status("root")
  assert.equal(state.journal[0].outcome, "completed")
  assert.equal(state.sessions[0].origin, notes.origin)
  assert.ok(!JSON.stringify(h.db.get("checkpoints/v1")).includes("NOT-PERSISTED"))
  await assert.rejects(h.update({ ...notes, origin: "Changed objective" }), /immutable/)
  await c.dispose()
})
test("crash during tool becomes unknown and stays blocked after restart", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.update(notes)
  await h.before("crashed")
  await c.dispose()
  const restarted = (await installCheckpoints(h.ctx))!
  assert.equal((await restarted.status("root")).journal[0].outcome, "unknown")
  await assert.rejects(h.before("new"), /paused\/unknown/)
  await assert.rejects(h.invoke("session/prompt", { sessionID: "root", prompt: { text: "please continue" } }), /paused\/unknown/)
  const state = await restarted.status("root")
  await assert.rejects(restarted.resume("root", { revision: state.revision, reconciliation: "Reviewed workspace and external effects", acknowledgeUnknown: false }), /acknowledgment/)
  await restarted.resume("root", { revision: state.revision, reconciliation: "Reviewed workspace and external effects; do not retry crashed operation", acknowledgeUnknown: true })
  await h.before("new")
  assert.equal((await restarted.status("root")).journal.find(j => j.call === "crashed")!.acknowledged, true)
})
test("concurrent calls serialize without losing journal entries", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.update(notes)
  await Promise.all(Array.from({ length: 40 }, (_, i) => h.before(`call${i}`)))
  assert.equal((await c.status("root")).journal.length, 40)
  await Promise.all(Array.from({ length: 40 }, (_, i) => h.after(`call${i}`)))
  assert.ok((await c.status("root")).journal.every(j => j.outcome === "completed"))
  await assert.rejects(h.before("call1"), /Duplicate/)
})
test("pause persistence failure does not interrupt and blocks captured executors", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  const captured = h.tools.get("open_enhance_checkpoint").execute
  h.fail("write", true)
  await assert.rejects(c.pause("root"), /write failed/)
  assert.deepEqual(h.interrupted, [])
  h.fail("write", false)
  await assert.rejects(captured(notes, { sessionID: "root" }), /fail-closed/)
  await assert.rejects(h.before("later"), /fail-closed/)
})
test("interrupt failures retain durable blocked parent and descendants including new children", async () => {
  const h = harness()
  h.sessions.set("child", { id: "child", parentID: "root", location: { directory: "/synthetic/workspace" } })
  h.sessions.set("grandchild", { id: "grandchild", parentID: "child", location: { directory: "/synthetic/workspace" } })
  const c = (await installCheckpoints(h.ctx))!
  await h.update(notes, "grandchild")
  await h.before("active", "grandchild")
  h.fail("interrupt", true)
  const result = await c.pause("root")
  assert.deepEqual(new Set(h.interrupted), new Set(["root", "child", "grandchild"]))
  assert.equal(result.interruptFailures.length, 3)
  assert.equal((await c.status("root")).sessions.find(entry => entry.id === "root")!.interruptFailures!.length, 3, "interruption uncertainty must survive status polling")
  assert.equal(result.status.journal[0].outcome, "unknown")
  await assert.rejects(h.before("blocked", "grandchild"), /paused\/unknown/)
  h.sessions.set("newchild", { id: "newchild", parentID: "root", location: { directory: "/synthetic/workspace" } })
  await assert.rejects(h.before("blocked", "newchild"), /paused\/unknown/)
  await assert.rejects(c.resume("child", { revision: result.status.revision, reconciliation: "Reviewed", acknowledgeUnknown: true }), /ancestor/)
})
test("forget only removes settled explicitly selected checkpoint history", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.update(notes)
  await h.before("pending")
  await assert.rejects(c.forget("root"), /unresolved/)
  await h.after("pending")
  await c.pause("root")
  await assert.rejects(c.forget("root"), /paused/)
  const status = await c.status("root")
  await c.resume("root", { revision: status.revision, reconciliation: "Reviewed settled task", acknowledgeUnknown: false })
  await c.forget("root")
  assert.equal((await c.status("root")).sessions.length, 0)
  await assert.rejects(h.before("new-task"), /nonempty/)
  await h.update({ ...notes, origin: "New explicit objective" })
})
test("pause does not deadlock an interrupt that awaits a tool after hook", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.update(notes)
  await h.before("active")
  h.ctx.session.interrupt = async () => { await h.after("active", "root", "error"); return { interrupted: true } }
  await c.pause("root")
  assert.equal((await c.status("root")).journal[0].outcome, "error")
})
test("storage read failure, corrupt records and deleted records fail closed", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  h.fail("read", true)
  await assert.rejects(h.before("blocked"), /read failed/)
  h.fail("read", false)
  await assert.rejects(c.status("root"), /fail-closed/)
  const corrupt = harness(), loaded = (await installCheckpoints(corrupt.ctx))!
  corrupt.db.set("checkpoints/v1", { version: 1, revision: 1, sessions: [], journal: [{ outcome: "pending" }] })
  await assert.rejects(corrupt.before("blocked"), /Invalid/)
  corrupt.db.delete("checkpoints/v1")
  await assert.rejects(loaded.status("root"), /disappeared/)
})
test("schema validation rejects unsafe notes and untrusted stored fields", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  for (const bad of [{ ...notes, paths: ["../secret"] }, { ...notes, paths: ["/secret"] }, { ...notes, paths: ["a\\b"] }, { ...notes, chainOfThought: "no" }, { ...notes, current: "a".repeat(1001) }, { ...notes, decisions: Array(13).fill("x") }]) await assert.rejects(h.update(bad))
  await h.update(notes)
  const original = structuredClone(h.db.get("checkpoints/v1")) as any
  for (const mutate of [(s: any) => { s.sessions[0].paused = "false" }, (s: any) => { s.sessions[0].unknown = true }, (s: any) => { s.sessions.push(s.sessions[0]) }, (s: any) => { s.revision = -1 }, (s: any) => { s.sessions[0].paths = ["../secret"] }]) {
    const state = structuredClone(original); mutate(state); h.db.set("checkpoints/v1", state)
    await assert.rejects(c.status("root"))
  }
})
test("explicit resume command validates revision, rejects ordinary prompts, handles moves without filesystem reads", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.update(notes)
  const oldWorkspace = (await c.status("root")).sessions[0].workspace
  await c.pause("root")
  const state = await c.status("root")
  await assert.rejects(h.invoke("session/prompt", { sessionID: "root", prompt: { text: "resume" } }))
  for (const input of [{ revision: state.revision, reconciliation: "", acknowledgeUnknown: true }, { revision: state.revision - 1, reconciliation: "Reviewed", acknowledgeUnknown: true }]) await assert.rejects(c.resume("root", input))
  h.sessions.get("root").location.directory = "/synthetic/moved"
  await assert.rejects(c.resume("root", { revision: state.revision, reconciliation: "Review before move is stale", acknowledgeUnknown: true }), /revision/)
  const refreshed = await c.status("root")
  await h.commands.get("enhance-resume").execute({ sessionID: "root", prompt: { text: JSON.stringify({ revision: refreshed.revision, reconciliation: "Reviewed moved workspace and edits via native permission-checked tools", acknowledgeUnknown: true }) } })
  assert.notEqual((await c.status("root")).sessions[0].workspace, oldWorkspace)
  assert.deepEqual((await c.status("root")).blockedBy, [])
  assert.ok(h.instructions.get("root/open-enhance-checkpoint")!.includes("NOT safe to retry"))
  await h.before("allowed")
})
test("unrelated session activity does not invalidate a paused resume form", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  h.sessions.set("other", { id: "other", location: { directory: "/synthetic/other" } })
  await h.update(notes)
  await c.pause("root")
  const before = await c.status("root")
  await h.update({ ...notes, origin: "Other task" }, "other")
  await h.before("other-call", "other")
  await h.after("other-call", "other")
  assert.equal((await c.status("root")).revision, before.revision)
  await c.resume("root", { revision: before.revision, reconciliation: "Reviewed root only", acknowledgeUnknown: false })
})
test("stable executor snapshot rereads durable pause and context teaches bounded maintenance", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  const execute = h.tools.get("open_enhance_checkpoint").execute
  const context = { sessionID: "root", system: [] as any[] }
  await h.invoke("session/context", context)
  assert.match(context.system[0].text, /Never include chain-of-thought/)
  await c.pause("root")
  await assert.rejects(execute(notes, { sessionID: "root" }), /paused\/unknown/)
  await c.dispose()
  await assert.rejects(execute(notes, { sessionID: "root" }), /disposed/)
})

test("no side-effect dispatch until the agent maintains a nonempty task checkpoint", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await assert.rejects(h.before("shell1"), /before any other tool/)
  await h.before("checkpoint1", "root", "open_enhance_checkpoint")
  await h.update(notes)
  await h.after("checkpoint1")
  await h.before("shell1")
  assert.equal((await c.status("root")).journal.length, 2)
})

test("status scopes notes and journals to requested ancestry/tree, never unrelated sessions", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  h.sessions.set("unrelated", { id: "unrelated", location: { directory: "/synthetic/other" } })
  h.sessions.set("child", { id: "child", parentID: "root", location: { directory: "/synthetic/workspace" } })
  await h.update(notes)
  await h.update({ ...notes, origin: "PRIVATE-OTHER-TASK" }, "unrelated")
  await h.update(notes, "child")
  await h.before("unrelated-call", "unrelated")
  const state = await c.status("root")
  assert.deepEqual(state.sessions.map(s => s.id), ["root", "child"])
  assert.ok(!JSON.stringify(state).includes("PRIVATE-OTHER-TASK"))
  assert.equal(state.journal.length, 0)
  assert.deepEqual((await c.status("child")).sessions.map(s => s.id), ["root", "child"])
})

test("no-argument API/command resume only requests reconciliation and never unblocks", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await c.pause("root")
  assert.equal((await c.resume("root")).state, "needs-reconciliation")
  await h.commands.get("enhance-resume").execute({ sessionID: "root", prompt: { text: "" } })
  assert.equal((await c.status("root")).state, "paused")
  assert.match(h.instructions.get("root/open-enhance-checkpoint-status")!, /needs-reconciliation/)
})

test("after-hook storage failure recovers as unknown, never assumes completion", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.update(notes)
  await h.before("active")
  h.fail("write", true)
  await assert.rejects(h.after("active"), /write failed/)
  h.fail("write", false)
  await assert.rejects(h.before("later"), /fail-closed/)
  await c.dispose()
  const restarted = (await installCheckpoints(h.ctx))!
  assert.equal((await restarted.status("root")).state, "unknown")
})

test("resume cannot reopen gate while native interruption is still in progress", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  let finish!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const wait = new Promise<void>(resolve => { finish = resolve })
  h.ctx.session.interrupt = async () => { entered(); await wait; return { interrupted: true } }
  const pause = c.pause("root")
  await started
  const state = await c.status("root")
  await assert.rejects(c.resume("root", { revision: state.revision, reconciliation: "Reviewed", acknowledgeUnknown: true }), /still in progress/)
  await assert.rejects(c.pause("root"), /still in progress/)
  finish()
  await pause
  assert.equal((await c.status("root")).state, "paused")
})

test("journal capacity never evicts unresolved calls", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.update(notes)
  await Promise.all(Array.from({ length: 256 }, (_, i) => h.before(`call${i}`)))
  await assert.rejects(h.before("overflow"), /full of unresolved/)
  await h.after("call0")
  await h.before("overflow")
  const state = await c.status("root")
  assert.equal(state.journal.length, 256)
  assert.ok(!state.journal.some(j => j.call === "call0"))
  assert.ok(state.journal.every(j => j.outcome === "pending"))
})

test("cyclic ancestry and corrupt timestamps are rejected", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.update(notes)
  await h.before("active")
  const state = structuredClone(h.db.get("checkpoints/v1")) as any
  state.journal[0].startedAt = -1
  h.db.set("checkpoints/v1", state)
  await assert.rejects(c.status("root"), /timestamps/)
  state.journal[0].startedAt = 1
  h.db.set("checkpoints/v1", state)
  h.sessions.get("root").parentID = "root"
  await assert.rejects(c.status("root"), /ancestry/)
})
