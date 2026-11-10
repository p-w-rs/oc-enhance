import { test } from "node:test"
import assert from "node:assert/strict"
import { handoffMarkdown, handoffName, notesText, parseHandoff, parseNotes, TaskNotes } from "./notes.js"

const kv = () => { const map = new Map<string, unknown>(); return { map, get: async (k: string) => structuredClone(map.get(k)), set: async (k: string, v: unknown) => { map.set(k, structuredClone(v)) }, remove: async (k: string) => { map.delete(k) } } }
const tree = { root: undefined, child: "root", grandchild: "child", other: undefined } as Record<string, string | undefined>
const host = () => {
  const interrupted: string[] = []
  return {
    interrupted,
    parent: async (id: string) => tree[id],
    children: async (id: string) => Object.keys(tree).filter(key => tree[key] === id),
    interrupt: async (id: string) => { interrupted.push(id) },
  }
}

test("notes: validated, shown as text, and the first request is kept until notes exist", async () => {
  assert.throws(() => parseNotes({ goal: "" }), /goal is required/)
  assert.throws(() => parseNotes({ goal: "x".repeat(2001) }), /longer than 2000/)
  const store = new TaskNotes(kv(), host())
  await store.remember("root", "Please migrate the billing service to Postgres")
  assert.equal(notesText(await store.get("root")), "The user's original request: Please migrate the billing service to Postgres")
  await store.save("root", parseNotes({ goal: "Migrate billing to Postgres", progress: "Schema done", next: "Port queries", decisions: ["Keep UUIDs"], files: ["db/schema.sql"] }))
  await store.remember("root", "a later message")
  assert.equal(notesText(await store.get("root")), "Goal: Migrate billing to Postgres\nDone so far: Schema done\nNext: Port queries\nDecisions: Keep UUIDs\nFiles: db/schema.sql")
})

test("pause: saved first, interrupts the session and its subagents, holds descendants until resume", async () => {
  const h = host()
  const store = new TaskNotes(kv(), h)
  store.started("grandchild", "call-1", "shell")
  const result = await store.pause("root")
  assert.deepEqual(h.interrupted.sort(), ["child", "grandchild", "root"])
  assert.deepEqual(result.interrupted, ["shell"])
  assert.equal(await store.pausedBy("grandchild"), "root")
  assert.equal(await store.pausedBy("other"), undefined, "other sessions are not affected")
  assert.equal(await store.resume("root"), true)
  assert.equal(await store.pausedBy("grandchild"), undefined)
  assert.equal(await store.resume("root"), false)
})

test("handoff files round-trip and are readable Markdown", () => {
  const notes = parseNotes({ goal: "Ship the Q3 report", progress: "Charts drafted", next: "Write the summary", decisions: ["Use EUR"], files: ["report/q3.md", "data/sales.xlsx"] })
  const markdown = handoffMarkdown(notes, new Date("2026-11-10T00:00:00Z"))
  assert.match(markdown, /^# Handoff: Ship the Q3 report/)
  assert.match(markdown, /## Next\n\nWrite the summary/)
  assert.deepEqual(parseHandoff(markdown), notes)
  assert.deepEqual(parseHandoff("## Goal\n\nOnly a goal\n"), { goal: "Only a goal", progress: "", next: "", decisions: [], files: [] })
  assert.equal(handoffName("Ship the Q3 report!"), "ship-the-q3-report")
  assert.throws(() => handoffName("!!!"), /letters or digits/)
})
