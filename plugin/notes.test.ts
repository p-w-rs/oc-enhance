import { test } from "node:test"
import assert from "node:assert/strict"
import { checkpointPrompt, describeCall, handoffMarkdown, handoffName, notesNudge, notesText, parseCheckpoint, parseHandoff, parseNotes, resumePrompt, TaskNotes } from "./notes.js"

const kv = () => { const map = new Map<string, unknown>(); return { map, get: async (k: string) => structuredClone(map.get(k)), set: async (k: string, v: unknown) => { map.set(k, structuredClone(v)) }, remove: async (k: string) => { map.delete(k) } } }
const tree = { root: undefined, child: "root", grandchild: "child", other: undefined } as Record<string, string | undefined>
const host = () => {
  const interrupted: string[] = []
  const stopped: string[][] = []
  return {
    interrupted, stopped,
    stopShells: async (commands: string[]) => { stopped.push(commands); return commands.filter(command => command !== "already gone") },
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
  store.started("grandchild", "call-1", describeCall("shell", { command: "sleep 45 && make train" }))
  store.backgrounded("child", "sh_1", "shell: python serve.py", "python   serve.py")
  store.backgrounded("child", "sh_2", "shell: tail -f log", "tail -f log")
  store.backgrounded("child", "sh_3", "shell: gone", "already gone")
  store.shellEnded("sh_2")
  const result = await store.pause("root")
  assert.deepEqual(h.interrupted.sort(), ["child", "grandchild", "root"])
  assert.deepEqual(result.interrupted, ["shell: sleep 45 && make train"])
  assert.deepEqual(h.stopped, [["python   serve.py", "already gone"]], "running background shells are stopped; ended ones are not touched")
  assert.deepEqual(result.background, ["shell: python serve.py"], "only shells that were still running are reported")
  assert.equal(await store.pausedBy("grandchild"), "root")
  assert.equal(await store.pausedBy("other"), undefined, "other sessions are not affected")
  const was = await store.resume("root")
  assert.deepEqual(was!.interrupted, ["shell: sleep 45 && make train"])
  const prompt = resumePrompt(was)
  assert.match(prompt, /Interrupted by the pause: shell: sleep 45 && make train\. Check whether/)
  assert.match(prompt, /The pause also stopped these background commands: shell: python serve\.py\. They did not finish/)
  assert.equal(await store.pausedBy("grandchild"), undefined)
  assert.equal(await store.resume("root"), undefined)
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

test("notes nudge: none for short tasks, once a task grows without notes, when notes go stale, after compaction", () => {
  assert.equal(notesNudge(false, 3, 3), undefined)
  assert.match(notesNudge(false, 4, 4)!, /4 tool calls .* without saving task notes/)
  assert.equal(notesNudge(true, 30, 4), undefined)
  assert.match(notesNudge(true, 30, 8)!, /8 tool calls old/)
  assert.match(notesNudge(true, 30, 1, true)!, /just compacted/)
  assert.equal(describeCall("write", { path: "src/a.ts", content: "x" }), "write: src/a.ts")
  assert.equal(describeCall("read", {}), "read")
})

test("pause checkpoint: prompt names what was interrupted; reply parsed from JSON, even in a code fence", () => {
  const prompt = checkpointPrompt({ at: 0, interrupted: ["shell: make train"], background: ["shell: serve"] })
  assert.match(prompt, /interrupted: shell: make train/)
  assert.match(prompt, /stopped these background commands: shell: serve/)
  const notes = parseCheckpoint('Here:\n```json\n{"goal": "Train model", "progress": "data ready; training interrupted", "next": "rerun make train", "decisions": ["lr 3e-4"], "files": ["Makefile"]}\n```')
  assert.deepEqual(notes, { goal: "Train model", progress: "data ready; training interrupted", next: "rerun make train", decisions: ["lr 3e-4"], files: ["Makefile"] })
  assert.equal(parseCheckpoint(`{"goal": "${"x".repeat(5000)}"}`).goal.length, 2000, "long text is cut, not rejected")
  assert.throws(() => parseCheckpoint("I can't do that"), /no JSON/)
  assert.match(resumePrompt({ at: Date.now(), interrupted: [], checkpoint: "saved" }, ["<reminder>check</reminder>"]), /notes were updated when the pause started[\s\S]*came due while paused:\n<reminder>check/)
})

test("save records who saved the notes", async () => {
  const store = new TaskNotes(kv(), host())
  await store.save("x", parseNotes({ goal: "g" }), "checkpoint")
  assert.equal((await store.get("x")).saved?.by, "checkpoint")
})
