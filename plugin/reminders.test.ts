import { test } from "node:test"
import assert from "node:assert/strict"
import { reminderText, Reminders, type Reminder } from "./reminders.js"

const storage = () => {
  const map = new Map<string, unknown>()
  return {
    map,
    get: async (k: string) => structuredClone(map.get(k)),
    set: async (k: string, v: unknown) => { map.set(k, structuredClone(v)) },
    remove: async (k: string) => { map.delete(k) },
    scan: async ({ prefix }: { prefix: string }) => ({ entries: [...map].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }),
  }
}

function setup(options: { paused?: Set<string>; fail?: Set<string>; gone?: Set<string> } = {}) {
  let now = Date.parse("2026-11-11T10:00:00Z")
  const delivered: { reminder: Reminder; text: string }[] = []
  const store = storage()
  const host = {
    pausedBy: async (id: string) => options.paused?.has(id) ? id : undefined,
    deliver: async (reminder: Reminder, text: string) => { if (options.fail?.has(reminder.sessionID)) throw new Error("busy"); delivered.push({ reminder, text }) },
    exists: async (id: string) => !options.gone?.has(id),
  }
  const reminders = new Reminders(store, host, () => now)
  return { reminders, store, delivered, advance: (minutes: number) => { now += minutes * 60_000 }, at: () => now }
}

test("set validates input; list is per session and ordered; cancel only within the session", async () => {
  const { reminders } = setup()
  await assert.rejects(reminders.set("s", { minutes: 5, message: "  " }), /message is required/)
  await assert.rejects(reminders.set("s", { message: "x" }), /Give minutes/)
  await assert.rejects(reminders.set("s", { minutes: 0.1, message: "x" }), /at least 15 seconds/)
  await assert.rejects(reminders.set("s", { minutes: 8 * 1440, message: "x" }), /7 days/)
  await assert.rejects(reminders.set("s", { at: "tomorrow", message: "x" }), /ISO|date and time/)
  const late = await reminders.set("s", { minutes: 40, message: "check training" })
  const soon = await reminders.set("s", { at: "2026-11-11T10:10:00Z", message: "check download" })
  await reminders.set("other", { minutes: 5, message: "theirs" })
  assert.deepEqual((await reminders.list("s")).map(r => r.id), [soon.id, late.id])
  assert.equal(await reminders.cancel("other", soon.id), undefined, "another session cannot cancel it")
  assert.equal((await reminders.cancel("s", soon.id))?.message, "check download")
  assert.equal((await reminders.list("s")).length, 1)
})

test("due reminders are delivered once; paused sessions wait; failures retry; deleted sessions are dropped", async () => {
  const paused = new Set<string>(), fail = new Set<string>(["busy", "deleted"]), gone = new Set<string>(["deleted"])
  const { reminders, delivered, advance } = setup({ paused, fail, gone })
  await reminders.set("s", { minutes: 10, message: "check the build" })
  await reminders.set("p", { minutes: 10, message: "paused one" })
  await reminders.set("busy", { minutes: 10, message: "retry me" })
  await reminders.set("deleted", { minutes: 10, message: "nobody home" })
  paused.add("p")
  await reminders.tick()
  assert.equal(delivered.length, 0, "nothing is due yet")
  advance(11)
  await reminders.tick()
  await reminders.tick()
  assert.deepEqual(delivered.map(d => d.reminder.sessionID), ["s"], "delivered once, not to the paused session")
  assert.match(delivered[0]!.text, /<reminder id="r[^"]+" set="2026-11-11 10:00 UTC">\ncheck the build\n<\/reminder>/)
  assert.deepEqual((await reminders.list()).map(r => r.sessionID).sort(), ["busy", "p"], "failed delivery is kept for a retry; deleted session dropped")
  const due = await reminders.takeDue("p")
  assert.deepEqual(due.map(r => r.message), ["paused one"], "Resume takes the reminders that came due while paused")
  assert.deepEqual((await reminders.list("p")), [])
})

test("repeating reminders move to their next time; survive a new instance (restart)", async () => {
  const { reminders, store, delivered, advance, at } = setup()
  const r = await reminders.set("s", { minutes: 5, every: 5, message: "poll the queue" })
  advance(16)
  await reminders.tick()
  assert.equal(delivered.length, 1, "missed repeats collapse into one delivery")
  const next = (await reminders.list("s"))[0]!
  assert.equal(next.id, r.id)
  assert.ok(next.due > at() && next.due - at() <= 5 * 60_000)
  const restarted = new Reminders(store, { pausedBy: async () => undefined, deliver: async () => {}, exists: async () => true }, at)
  assert.equal((await restarted.list("s")).length, 1)
})

test("late reminders say so", () => {
  const reminder = { id: "r1", sessionID: "s", message: "m", due: 0, created: 0 }
  assert.match(reminderText(reminder, 3 * 3600_000), /due 3\.0 h ago; OpenCode was not running or the session was paused/)
  assert.doesNotMatch(reminderText(reminder, 30_000), /due/)
})
