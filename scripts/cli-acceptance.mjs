import { createServer } from "node:http"
import { spawn, execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, access, realpath } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import assert from "node:assert/strict"
import { releaseFingerprint } from "./release-fingerprint.mjs"

const repository = process.cwd()
const pixi = process.env.OPEN_ENHANCE_PIXI ?? process.env.PIXI_EXE ?? execFileSync("/usr/bin/which", ["pixi"], { encoding: "utf8" }).trim()
const temporary = path.join(await realpath(os.tmpdir()), "opencode")
await mkdir(temporary, { recursive: true, mode: 0o700 })
const base = await mkdtemp(path.join(temporary, "oe-cli-"))
const home = path.join(base, "home"), workspace = path.join(base, "workspace")
await mkdir(workspace); await mkdir(home)
const configuration = path.join(home, "config", "opencode")
await mkdir(configuration, { recursive: true })
const env = {
  HOME: home, TMPDIR: home,
  PATH: [path.dirname(pixi), path.join(repository, ".pixi/envs/default/bin"), "/usr/bin", "/bin"].join(":"),
  XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
  XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
  PIXI_OFFLINE: "true", PIXI_NO_CONFIG: "true", OPEN_ENHANCE_PIXI: pixi,
  OPENCODE_DISABLE_CLAUDE_CODE: "true",
}
await writeFile(path.join(workspace, "pixi.toml"), '[workspace]\nname="cli-acceptance"\nchannels=[]\nplatforms=["osx-arm64"]\n[tasks]\nprobe="pwd"\n')
execFileSync(pixi, ["lock"], { cwd: workspace, env, stdio: "pipe" })
const calls = [
  { name: "shell", input: { command: '(pwd > native-output) && cat < native-output', description: "Native shell works before checkpoint initialization" } },
  { name: "open_enhance_checkpoint", input: { origin: "Synthetic CLI acceptance", current: "Ready", next: "Check native shell and Pixi task", decisions: [], paths: [] } },
  { name: "shell", input: { command: "pixi run --locked probe", description: "Synthetic Pixi pwd task" } },
]
let requests = 0, modelRequests = 0
const server = createServer(async (req, res) => {
  const data = []
  for await (const part of req) data.push(part)
  let body
  try { body = JSON.parse(Buffer.concat(data).toString()) } catch { res.writeHead(400); res.end(); return }
  requests++
  const main = Array.isArray(body.tools) && body.tools.some(tool => tool.function?.name === "open_enhance_checkpoint")
  if (main) modelRequests++
  const call = main ? calls.shift() : undefined
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "probe", object: "chat.completion", model: "probe", choices: [{ index: 0, message: { role: "assistant", content: "Synthetic CLI probe" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    return
  }
  const chunk = (delta, finish_reason = null) => ({ id: "probe-" + requests, object: "chat.completion.chunk", created: 0, model: "probe", choices: [{ index: 0, delta, finish_reason }] })
  const chunks = call ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call-" + requests, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] }), chunk({}, "tool_calls")] : [chunk({ role: "assistant", content: main ? "LIVE_CLI_PROBE_COMPLETE" : "Synthetic CLI probe" }), chunk({}, "stop")]
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.end(chunks.map(value => "data: " + JSON.stringify(value) + "\n\n").join("") + "data: [DONE]\n\n")
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const port = server.address().port
await writeFile(path.join(configuration, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json", model: "probe/probe",
  plugins: [{ package: repository, options: { checkpoints: true, evidence: false, pixiExecutable: pixi } }],
  permissions: [{ action: "*", resource: "*", effect: "allow" }],
  providers: { probe: {
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "synthetic-not-a-secret" },
    models: { probe: { limit: { context: 32000, output: 1024 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } },
  } },
}))
let stdout = "", stderr = "", timedOut = false, outputOverflow = false
const child = spawn(path.join(repository, "node_modules/@opencode/cli-darwin-arm64/bin/opencode"), ["run", "--standalone", "--archived", "--format", "json", "--model", "probe/probe", "Synthetic CLI acceptance"], { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
const stop = () => { try { process.kill(-child.pid, "SIGKILL") } catch {} }
const capture = (data, name) => {
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + data.length > 2 * 1024 * 1024) { outputOverflow = true; stop(); return }
  if (name === "stdout") stdout += data; else stderr += data
}
child.stdout.on("data", data => capture(data, "stdout")); child.stderr.on("data", data => capture(data, "stderr"))
const timer = setTimeout(() => { timedOut = true; stop() }, 60000)
let code
try { code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve) }) }
finally { clearTimeout(timer); server.close() }
let nativeOutput = false
try { await access(path.join(workspace, "native-output")); nativeOutput = true } catch {}
const result = {
  schema: 1, fingerprint: releaseFingerprint(), test: "actual-project-cli-private-server",
  code, timedOut, outputOverflow, requests, modelRequests, scriptedCallsRemaining: calls.length, nativeOutput,
  completed: stdout.includes("LIVE_CLI_PROBE_COMPLETE"),
  provider: "local-scripted-SSE-not-a-real-LLM",
  passed: code === 0 && !timedOut && !outputOverflow && calls.length === 0 && nativeOutput && stdout.includes("LIVE_CLI_PROBE_COMPLETE") && !stdout.includes("open-enhance Pixi policy"),
  note: "Actual native CLI/plugin integration with a controlled local provider; not real-LLM quality, desktop rendering, or binary dependency remediation.",
}
await mkdir(path.join(repository, ".local/release"), { recursive: true, mode: 0o700 })
await writeFile(path.join(repository, ".local/release/cli-acceptance.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
await writeFile(path.join(repository, ".local/release/cli-acceptance-logs.txt"), stdout + "\n" + stderr, { mode: 0o600 })
console.log(JSON.stringify(result, null, 2))
assert.ok(result.passed, "See local CLI acceptance logs for this synthetic test")
