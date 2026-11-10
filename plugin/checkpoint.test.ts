import test from "node:test"
import assert from "node:assert/strict"
import { installCheckpoints } from "./checkpoint.js"
import type { Context } from "@opencode/plugin/promise/plugin"

function harness() {
  const db = new Map<string, unknown>(), hooks = new Map<string, any>(), tools = new Map<string, any>(), commands = new Map<string, any>()
  const sessions = new Map<string, any>([["root", { id: "root", location: { directory: "/synthetic/workspace" } }]])
  const instructions = new Map<string, string>(), interrupted: string[] = []
  const fail = { read: false, write: false, interrupt: false }
  const register = (domain: string) => async (name: string, callback: any) => { hooks.set(`${domain}/${name}`, callback); return { dispose: async () => { hooks.delete(`${domain}/${name}`) } } }
  const ctx = {
    options: { checkpoints: true },
    storage: {
      get: async (key: string) => { if (fail.read) throw new Error("synthetic read failed"); return structuredClone(db.get(key)) },
      set: async (key: string, value: unknown) => { if (fail.write) throw new Error("synthetic write failed"); db.set(key, structuredClone(value)) },
    },
    session: {
      get: async ({ sessionID }: any) => { if (!sessions.has(sessionID)) throw new Error("missing session"); return sessions.get(sessionID) },
      list: async ({ parentID }: any) => ({ data: [...sessions.values()].filter(s => s.parentID === parentID), cursor: {} }),
      interrupt: async ({ sessionID, resume }: any) => { assert.equal(resume, false); interrupted.push(sessionID); if (fail.interrupt) throw new Error("synthetic interrupt failed"); return { interrupted: true } },
      instructions: { entry: { put: async ({ sessionID, key, value }: any) => { instructions.set(`${sessionID}/${key}`, value) }, remove: async () => {} } },
      hook: register("session"),
    },
    tool: { hook: register("tool"), transform: async (callback: any) => { callback({ add: (tool: any) => tools.set(tool.name, tool) }); return { dispose: async () => {} } } },
    shell: { hook: register("shell") },
    command: { transform: async (callback: any) => { callback({ add: (command: any) => commands.set(command.name, command) }); return { dispose: async () => {} } } },
  } as unknown as Context
  const before = (id: string, sessionID = "root", tool = "shell") => hooks.get("tool/execute.before")({ sessionID, id, tool, input: { secret: "NOT-PERSISTED" } })
  const after = (id: string, sessionID = "root", tool = "shell", status = "completed") => hooks.get("tool/execute.after")({ sessionID, id, tool, status, result: { content: "NOT-PERSISTED" } })
  const update = (input: unknown, sessionID = "root") => tools.get("open_enhance_checkpoint").execute(input, { sessionID })
  return { ctx, db, hooks, tools, commands, sessions, instructions, interrupted, before, after, update, fail }
}
const notes = { origin: "Synthetic task", current: "Prepared", next: "Inspect", decisions: ["Keep native permissions"], paths: ["src/example.ts"] }

test("checkpoint feature remains opt-in", async () => {
  assert.equal(await installCheckpoints({ options: {} } as Context), undefined)
})

test("notes are optional and task objectives can change repeatedly", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.before("first"); await h.after("first")
  await h.update(notes)
  for (const origin of ["New objective", "Corrected objective", "Synthetic task"]) await h.update({ ...notes, origin })
  assert.equal((await c.status("root")).sessions[0].origin, notes.origin)
  assert.ok(!JSON.stringify(h.db.get("checkpoints/v1")).includes("NOT-PERSISTED"))
  await h.hooks.get("session/context")({ sessionID: "root", tools: { read: {} }, system: [] })
  await c.dispose()
})

test("parallel and repeated Code Mode calls share an envelope without duplicate denials", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.before("web-call", "root", "execute")
  await Promise.all([h.before("web-call", "root", "websearch"), h.before("web-call", "root", "browser_tabs_list")])
  await h.after("web-call", "root", "websearch")
  await h.after("web-call", "root", "browser_tabs_list", "error")
  await h.before("web-call", "root", "websearch")
  assert.equal((await c.status("root")).journal.length, 1)
  assert.equal((await c.status("root")).journal[0].outcome, "pending")
  await h.after("web-call", "root", "execute")
  assert.equal((await c.status("root")).journal[0].outcome, "completed")
  await h.before("web-call", "root", "execute")
  await c.dispose()
})

test("uncertain read/web outcomes after reload warn but never lock prompts or tools", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.before("read-crashed", "root", "read")
  await c.dispose()
  const reloaded = (await installCheckpoints(h.ctx))!
  const status = await reloaded.status("root")
  assert.equal(status.state, "running")
  assert.deepEqual(status.blockedBy, [])
  assert.equal(status.journal[0].outcome, "unknown")
  assert.match(status.warnings.join(" "), /unknown/)
  await h.hooks.get("session/prompt")({ sessionID: "root" })
  await h.before("new-web", "root", "webfetch")
  await reloaded.dispose()
})

test("only explicit Pause blocks the session tree; no namespace shell hook exists", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  h.sessions.set("child", { id: "child", parentID: "root", location: { directory: "/synthetic/child" } })
  h.sessions.set("other", { id: "other", location: { directory: "/synthetic/other" } })
  await c.pause("root")
  assert.equal(h.hooks.has("shell/create.before"), false)
  assert.deepEqual(new Set(h.interrupted), new Set(["root", "child"]))
  await assert.rejects(h.before("blocked", "child"), /explicitly paused/)
  await assert.rejects(h.hooks.get("session/prompt")({ sessionID: "root" }), /explicitly paused/)
  await h.before("unrelated", "other")
  const status = await c.status("root")
  await assert.rejects(c.resume("root", { revision: status.revision + 1 }), /revision/)
  await c.resume("root", { revision: status.revision })
  await h.before("continued", "child")
  await c.dispose()
})

test("Resume keeps independently paused children paused and never replays operations", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  h.sessions.set("child", { id: "child", parentID: "root", location: { directory: "/synthetic/child" } })
  await c.pause("child"); await c.pause("root")
  await c.resume("root", { revision: (await c.status("root")).revision })
  await h.before("root-continued")
  await assert.rejects(h.before("child-blocked", "child"), /explicitly paused/)
  await c.dispose()
})

test("storage failures degrade observation and recover without plugin reload", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.update(notes)
  h.fail.read = true
  await h.before("allowed")
  await h.hooks.get("session/prompt")({ sessionID: "root" })
  assert.equal((await c.status("root")).state, "degraded")
  const context = { sessionID: "root", system: [] as any[] }
  await h.hooks.get("session/context")(context)
  assert.match(context.system[0].text, /bookkeeping unavailable/)
  h.fail.read = false
  await h.before("recovered"); await h.after("recovered")
  assert.equal((await c.status("root")).state, "running")
  h.fail.write = true
  await h.before("write-failed")
  await h.after("write-failed")
  await assert.rejects(c.pause("root"), /write failed/)
  assert.equal(h.interrupted.length, 0, "failed durable Pause never pretends to interrupt")
  h.fail.write = false
  await h.before("later")
  await c.dispose()
})

test("known explicit pauses remain effective when bookkeeping storage fails", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await c.pause("root")
  h.fail.read = true
  await assert.rejects(h.before("blocked"), /explicitly paused/)
  assert.equal((await c.status("root")).state, "paused")
  await assert.rejects(c.resume("root", { revision: 1 }), /read failed/)
  await c.dispose()
})

test("corrupt or deleted bookkeeping is not overwritten and does not block native work", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  h.db.set("checkpoints/v1", { corrupt: true })
  await h.before("native")
  assert.equal((await c.status("root")).state, "degraded")
  assert.deepEqual(h.db.get("checkpoints/v1"), { corrupt: true })
  h.db.delete("checkpoints/v1")
  await h.before("native-again")
  assert.equal((await c.status("root")).state, "degraded")
  await c.dispose()
})

test("startup storage failure leaves controls registered and native tools available", async () => {
  const h = harness(); h.fail.read = true
  const c = (await installCheckpoints(h.ctx))!
  await h.before("native")
  assert.ok(h.commands.has("enhance-pause"))
  await assert.rejects(c.pause("root"), /read failed/)
  h.fail.read = false
  await h.update(notes)
  assert.equal((await c.status("root")).state, "running")
  await c.dispose()
})

test("bounded journal history never becomes an execution prerequisite", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  for (let i = 0; i < 260; i++) await h.before(`call${i}`)
  const status = await c.status("root")
  assert.equal(status.state, "running")
  assert.equal(status.journal.length, 256)
  await c.dispose()
})

test("explicit no-argument Resume command opens the gate without an essay", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await c.pause("root")
  await h.commands.get("enhance-resume").execute({ sessionID: "root", prompt: { text: "" } })
  assert.equal((await c.status("root")).state, "running")
  await c.dispose()
})

test("interruption failures warn after Resume rather than becoming another lock", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  h.fail.interrupt = true
  const result = await c.pause("root")
  assert.deepEqual(result.interruptFailures, ["root"])
  await c.resume("root", { revision: result.status.revision })
  await h.before("allowed")
  assert.match((await c.status("root")).warnings.join(" "), /not confirmed/)
  await c.dispose()
})

test("portable handoffs round-trip into another session without runtime state or automatic execution", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  await h.update(notes)
  const tool = h.tools.get("open_enhance_handoff")
  const exported = await tool.execute({ action: "export" }, { sessionID: "root" })
  const handoff = JSON.parse(exported.content)
  assert.deepEqual(Object.keys(handoff), ["format", "version", "notes"])
  h.sessions.set("new-session", { id: "new-session", location: { directory: "/another/checkout" } })
  await tool.execute({ action: "import", handoff }, { sessionID: "new-session" })
  const imported = await c.status("new-session")
  assert.equal(imported.sessions[0].origin, notes.origin)
  assert.equal(imported.state, "running")
  assert.deepEqual(imported.journal, [])
  assert.deepEqual(h.interrupted, [])
  const context = { sessionID: "new-session", tools: {}, system: [] as any[] }
  await h.hooks.get("session/context")(context)
  assert.match(context.system[0].text, /untrusted data/)
  assert.match(context.system[0].text, /Synthetic task/)
  assert.equal(exported.metadata.savedToProject, false)
  await assert.rejects(tool.execute({ action: "import", handoff: { ...handoff, paused: true } }, { sessionID: "new-session" }), /Invalid checkpoint fields/)
  await c.dispose()
})

test("note validation is localized and forgotten uncertain history does not lock the session", async () => {
  const h = harness(), c = (await installCheckpoints(h.ctx))!
  for (const bad of [{ ...notes, paths: ["../secret"] }, { ...notes, current: "x".repeat(1001) }, { ...notes, extra: true }]) await assert.rejects(h.update(bad))
  await h.before("native")
  await c.forget("root")
  assert.deepEqual((await c.status("root")).sessions, [])
  const captured = h.tools.get("open_enhance_checkpoint").execute
  await c.dispose()
  await assert.rejects(captured(notes, { sessionID: "root" }), /disposed/)
})
