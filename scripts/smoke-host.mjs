// End-to-end check against a real OpenCode CLI (pinned) in an isolated home with a scripted local model (not a real
// LLM). Verifies inside OpenCode's own runtime: tools and the pixi skill load, task notes reach the model, documents
// (Word, Excel, PowerPoint, PDF) are read, project search works (meaning-based when the engine was downloaded with
// pixi run setup-search), handoffs are written into the project, and terminal tools explain that Desktop is needed.
// --snapshot loads a verified installed snapshot instead of the checkout.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { symlink } from "node:fs/promises"
import { docx, pdf, pptx, xlsx } from "../plugin/testdocs.ts"

const OPENCODE_VERSION = "2.2.6"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cliPackage = `@opencode/cli-${process.platform}-${process.arch}`
const binary = path.join(root, ".local", "host", "node_modules", cliPackage, "bin", "opencode")
export async function ensureCli() {
  try { await access(binary); return binary } catch {}
  console.log(`Installing ${cliPackage}@${OPENCODE_VERSION} into .local/host ...`)
  await mkdir(path.join(root, ".local", "host"), { recursive: true })
  const result = spawnSync("npm", ["install", "--no-save", "--no-package-lock", "--ignore-scripts", "--prefix", path.join(root, ".local", "host"), "--cache", path.join(root, ".local", "npm-cache"), `${cliPackage}@${OPENCODE_VERSION}`], { stdio: "inherit" })
  if (result.status !== 0) throw new Error(`Could not install ${cliPackage}@${OPENCODE_VERSION}`)
  return binary
}
if (process.argv.includes("--install-cli")) { await ensureCli(); process.exit(0) }
await ensureCli()

const base = await mkdtemp(path.join(await realpath(os.tmpdir()), "oc-enhance-smoke-"))
const home = path.join(base, "home"), workspace = path.join(base, "workspace"), data = path.join(base, "data")
await mkdir(path.join(workspace, "docs"), { recursive: true }); await mkdir(path.join(workspace, "src")); await mkdir(path.join(home, "config", "opencode"), { recursive: true }); await mkdir(path.join(data, "search"), { recursive: true })
await writeFile(path.join(workspace, "docs", "travel.docx"), docx(["Travel policy", "Employees may claim a hotel and meals when a flight is cancelled overnight."]))
await writeFile(path.join(workspace, "docs", "budget.xlsx"), xlsx({ Budget: [["Item", "Cost"], ["Laptop", 1499]] }))
await writeFile(path.join(workspace, "docs", "review.pptx"), pptx([{ text: ["Q3 review"] }, { text: ["Churn fell to 2%"] }]))
await writeFile(path.join(workspace, "docs", "invoice.pdf"), pdf(["Invoice 4711 total 99 EUR"]))
await writeFile(path.join(workspace, "src", "sessions.ts"), "export function evictIdleSessions() {\n  // remove sessions idle for more than 30 minutes\n}\n")
// Reuse the checkout's downloaded search engine, if any.
const engine = path.join(root, ".local", "search")
let semantic = false
try { for (const entry of await (await import("node:fs/promises")).readdir(engine)) if (entry.startsWith("runtime-")) { await symlink(path.join(engine, entry), path.join(data, "search", entry)); semantic = true } } catch {}

let pluginPath = root
if (process.argv.includes("--snapshot")) {
  process.env.XDG_DATA_HOME = path.join(home, "data")
  const { deploy, verifyRelease } = await import("./install.mjs")
  pluginPath = await deploy()
  await verifyRelease(pluginPath)
  console.log(`Using snapshot ${pluginPath}`)
}

const calls = [
  { name: "save_task_notes", input: { goal: "Answer travel and budget questions", progress: "Started", next: "Read the documents", files: ["docs/travel.docx"] } },
  { name: "read_document", input: { path: "docs/travel.docx" } },
  { name: "read_document", input: { path: "docs/budget.xlsx", part: "Budget" } },
  { name: "read_document", input: { path: "docs/review.pptx", part: "2" } },
  { name: "read_document", input: { path: "docs/invoice.pdf" } },
  { name: "search_project", input: { query: "what happens if my flight is cancelled" } },
  { name: "search_project", input: { query: "where are inactive sessions cleaned up" } },
  { name: "task_handoff", input: { action: "export", name: "travel questions" } },
  { name: "terminal_list", input: {} },
]
const toolResults = []
const systems = []
let modelRequests = 0, toolNames = []
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const part of req) chunks.push(part)
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { res.writeHead(400); res.end(); return }
  const main = Array.isArray(body.tools) && body.tools.some(tool => tool.function?.name === "read_document")
  if (main) {
    modelRequests++
    toolNames = body.tools.map(tool => tool.function?.name)
    systems.push((body.messages ?? []).filter(message => message.role === "system").map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n"))
    toolResults.length = 0
    for (const message of body.messages ?? []) if (message.role === "tool") toolResults.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content))
  }
  const call = main ? calls.shift() : undefined
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "probe", choices: [{ index: 0, message: { role: "assistant", content: "Smoke" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    return
  }
  const chunk = (delta, finish_reason = null) => ({ id: `c${modelRequests}`, object: "chat.completion.chunk", created: 0, model: "probe", choices: [{ index: 0, delta, finish_reason }] })
  const events = call
    ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call-${modelRequests}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] }), chunk({}, "tool_calls")]
    : [chunk({ role: "assistant", content: main ? "OC_ENHANCE_SMOKE_COMPLETE" : "Smoke" }), chunk({}, "stop")]
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.end(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n")
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
await writeFile(path.join(home, "config", "opencode", "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json", model: "probe/probe",
  plugins: [{ package: pluginPath, options: { dataDirectory: data } }],
  providers: { probe: {
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-not-a-secret" },
    models: { probe: { limit: { context: 64000, output: 1024 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } },
  } },
}))
const env = {
  HOME: home, TMPDIR: home, PATH: [path.join(root, ".pixi/envs/default/bin"), "/usr/bin", "/bin"].join(":"),
  XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
  OPENCODE_DISABLE_CLAUDE_CODE: "true",
}
let stdout = "", stderr = ""
const child = spawn(binary, ["run", "--standalone", "--auto", "--format", "json", "--model", "probe/probe", "oc-enhance smoke"], { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
child.stdout.on("data", data => { stdout += data }); child.stderr.on("data", data => { stderr += data })
const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, 240_000)
const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve) })
clearTimeout(timer); server.close()

const logs = path.join(root, ".local", "smoke-host.log")
await mkdir(path.dirname(logs), { recursive: true })
await writeFile(logs, `${stdout}\n----- stderr -----\n${stderr}`, { mode: 0o600 })
try {
  assert.equal(code, 0, `opencode exited ${code}; see ${logs}`)
  assert.equal(calls.length, 0, "every scripted call was made")
  assert.ok(stdout.includes("OC_ENHANCE_SMOKE_COMPLETE"), "run completed")
  assert.doesNotMatch(stderr, /\[oc-enhance\] (disabled|reload failed|pixi skill not registered)/, "no plugin warnings")
  for (const name of ["save_task_notes", "task_handoff", "read_document", "search_project", "terminal_list", "terminal_write"]) assert.ok(toolNames.includes(name), `${name} offered`)
  assert.match(systems.at(-1), /Python only through Pixi/)
  assert.match(systems.at(-1), /Goal: Answer travel and budget questions/, "task notes reach the model")
  const all = toolResults.join("\n")
  assert.match(all, /flight is cancelled overnight/, "Word read")
  assert.match(all, /Laptop\\t1499|Laptop\t1499/, "Excel read")
  assert.match(all, /Churn fell to 2%/, "PowerPoint read")
  assert.match(all, /Invoice 4711 total 99 EUR/, "PDF read inside OpenCode")
  assert.match(all, semantic ? /semantic ranking/ : /keyword ranking/)
  assert.match(all, /1\. docs\/travel\.docx/, "search finds the policy")
  assert.match(all, /1\. src\/sessions\.ts/, "search finds the code")
  assert.match(await (await import("node:fs/promises")).readFile(path.join(workspace, ".opencode", "handoffs", "travel-questions.md"), "utf8"), /# Handoff: Answer travel and budget questions/)
  assert.match(all, /Desktop/, "terminal tools explain that Desktop is needed")
  if (pluginPath !== root) await (await import("./install.mjs")).verifyRelease(pluginPath)
  console.log(`oc-enhance host smoke passed${pluginPath !== root ? " from a snapshot" : ""} (OpenCode ${OPENCODE_VERSION}, ${process.platform}-${process.arch}, ${semantic ? "meaning-based" : "keyword"} search, ${modelRequests} model requests).`)
  await rm(base, { recursive: true, force: true })
} catch (error) {
  console.error(`Smoke failed. Scratch home kept at ${base}; logs at ${logs}`)
  throw error
}
