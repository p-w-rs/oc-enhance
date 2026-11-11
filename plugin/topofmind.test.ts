import { test } from "node:test"
import assert from "node:assert/strict"
import { capabilityIndex, cueText, modelPrompt, parseModelCues, parseModelRef, recent, ruleCues, TopOfMind } from "./topofmind.js"

const tools = {
  read: { description: "Read a file." }, shell: { description: "Run a command." }, skill: { description: "Load a skill." },
  read_document: { description: "Read Word (.docx), Excel, PowerPoint or PDF files as text. More detail." },
  reminder: { description: "Timers for yourself. set: wake this session later." },
  library_search: { description: "Search the reference library." },
  search_project: { description: "Find where something is described or implemented." },
}
const skills = [{ name: "gnuplot", description: "Make excellent figures with gnuplot 6, heatmaps, contours, surfaces, animations." }, { name: "pixi", description: "Use Pixi for environments." }]
const index = capabilityIndex(tools, skills)
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
const call = (name: string, input: unknown = {}) => ({ role: "assistant", content: [{ type: "tool-call", id: "c", name, input }] })

test("capability index: one line per tool and skill, without the skill tool itself", () => {
  assert.deepEqual(index.map(item => item.name), ["read", "shell", "read_document", "reminder", "library_search", "search_project", "skill:gnuplot", "skill:pixi"])
  assert.equal(index.find(item => item.name === "read_document")!.summary, "Read Word (.docx), Excel, PowerPoint or PDF files as text.")
})

test("recent: latest real user message; tools used since then; reminders and wake-ups are not user messages", () => {
  const r = recent([user("first"), call("read"), user("see docs/spec.docx please"), call("skill", { name: "pixi" }), { role: "user", content: [{ type: "text", text: "<reminder id=\"r1\">check</reminder>" }] }])
  assert.equal(r.user, "see docs/spec.docx please")
  assert.deepEqual([...r.used].sort(), ["skill", "skill:pixi"])
  assert.equal(r.calls, 2)
})

test("rules fire for the moments they describe and not otherwise", () => {
  const names = (text: string, extra: unknown[] = []) => ruleCues(index, recent([user(text), ...extra])).map(cue => cue.name)
  assert.deepEqual(names("Summarize docs/requirements.docx for me"), ["read_document"])
  assert.deepEqual(names("Training takes about 40 minutes, check back on it"), ["reminder"])
  assert.deepEqual(names("Quote the ASA statement and give a citation"), ["library_search"])
  assert.deepEqual(names("Where is the retry logic implemented?"), ["search_project"])
  assert.deepEqual(names("Make a contour plot heatmap figure of this surface with gnuplot"), ["skill:gnuplot"])
  assert.deepEqual(names("Rename the variable x to y in main.ts"), [])
  assert.deepEqual(names("Summarize docs/requirements.docx", [call("read_document")]), [], "already used for this message")
  assert.deepEqual(ruleCues(capabilityIndex({ read: {} }), recent([user("open spec.docx")])), [], "only capabilities the session has")
})

test("cues: each at most twice per user message; model cues join from the next request; model failure falls back to rules", async () => {
  const asked: string[] = []
  let reply = '{"cues": [{"name": "gnuplot", "why": "they want a figure next"}, {"name": "read", "why": "basic"}, {"name": "nope", "why": "x"}]}'
  const tom = new TopOfMind({ generate: async (_model, prompt) => { asked.push(prompt); return reply }, warn: () => {} })
  const model = parseModelRef("opencode-go/fast-1")!
  const messages = [user("Training takes about 40 minutes, check back on it")]
  assert.deepEqual(tom.cues("s", index, recent(messages), model).map(c => c.name), ["reminder"])
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(tom.cues("s", index, recent(messages), model).map(c => `${c.name}/${c.source}`), ["reminder/rule", "skill:gnuplot/model"])
  assert.deepEqual(tom.cues("s", index, recent(messages), model).map(c => c.name), ["skill:gnuplot"], "reminder shown twice already")
  assert.deepEqual(tom.cues("s", index, recent(messages), model).map(c => c.name), [])
  assert.equal(asked.length, 1, "one model request per user message")
  assert.match(asked[0]!, /- reminder: Timers for yourself\./)
  assert.equal(tom.last("s")!.cues[0]!.name, "skill:gnuplot")
  reply = "garbage"
  assert.deepEqual(tom.cues("t", index, recent([user("Where is the parser?")]), model).map(c => c.name), ["search_project"])
})

test("model answers are validated; refs and text formats", () => {
  assert.deepEqual(parseModelCues("```json\n{\"cues\":[{\"name\":\"pixi\",\"why\":\"env setup\"}]}\n```", index), [{ name: "skill:pixi", why: "env setup", source: "model" }])
  assert.deepEqual(parseModelCues("no", index), [])
  assert.deepEqual(parseModelRef("opencode-go/deepseek-v4.1-flash"), { providerID: "opencode-go", id: "deepseek-v4.1-flash" })
  assert.deepEqual(parseModelRef("huggingface/Qwen/Qwen3.8-27B"), { providerID: "huggingface", id: "Qwen/Qwen3.8-27B" })
  assert.equal(parseModelRef(""), undefined)
  assert.match(cueText([{ name: "skill:pixi", why: "w", source: "rule" }]), /^Top of mind for this step .*\n- skill pixi: w$/)
  assert.match(modelPrompt(index, recent([user("hi")])), /Answer with JSON only/)
})
