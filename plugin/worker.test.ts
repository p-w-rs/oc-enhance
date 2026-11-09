import { test } from "node:test"
import assert from "node:assert/strict"
import { createWorkerEnvironment, WorkerPool } from "./worker.js"
import path from "node:path"

const options = (script: string, extra = {}) => ({
  executable: process.execPath,
  args: ["-e", script],
  cwd: process.cwd(),
  ...extra,
})
const signal = () => new AbortController().signal

test("worker sends JSON on stdin and parses JSON stdout", async () => {
  const pool = new WorkerPool()
  const result = await pool.run({ query: "spaces ' ; 中文" }, options("let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(s))"), signal())
  assert.deepEqual(result, { query: "spaces ' ; 中文" })
  await pool.close()
})

test("worker handles invalid JSON, nonzero exit, missing executable", async () => {
  const pool = new WorkerPool()
  await assert.rejects(pool.run({}, options("console.log('not json')"), signal()), /invalid JSON/)
  await assert.rejects(pool.run({}, options("console.error('PRIVATE SOURCE');process.exit(2)"), signal()), (error: Error) => /exit 2/.test(error.message) && !error.message.includes("PRIVATE"))
  await assert.rejects(pool.run({}, { ...options(""), executable: "/nonexistent/open-enhance-worker" }, signal()), /ENOENT/)
  await pool.close()
})

test("worker bounds both output streams", async () => {
  const pool = new WorkerPool()
  await assert.rejects(pool.run({}, options("process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)", { maxStdout: 100 }), signal()), /stdout exceeded/)
  await assert.rejects(pool.run({}, options("process.stderr.write('x'.repeat(8192));setInterval(()=>{},1000)", { maxStderr: 100 }), signal()), /stderr exceeded/)
  await pool.close()
})

test("default response and stderr budgets remain 2 MiB and 64 KiB", async () => {
  const pool = new WorkerPool()
  try {
    await assert.rejects(pool.run({}, options("process.stdout.write('x'.repeat(2*1024*1024+1));setInterval(()=>{},1000)"), signal()), /stdout exceeded/)
    await assert.rejects(pool.run({}, options("process.stderr.write('x'.repeat(64*1024+1));setInterval(()=>{},1000)"), signal()), /stderr exceeded/)
  } finally { await pool.close() }
})

test("worker timeout, cancellation, and unload await closure", async () => {
  const pool = new WorkerPool()
  await assert.rejects(pool.run({}, options("setInterval(()=>{},1000)", { timeoutMs: 30 }), signal()), /timed out/)
  const controller = new AbortController()
  const task = pool.run({}, options("setInterval(()=>{},1000)"), controller.signal)
  const rejected = assert.rejects(task, /cancelled/)
  controller.abort()
  await rejected
  const outstanding = pool.run({}, options("setInterval(()=>{},1000)"), signal())
  const unloaded = assert.rejects(outstanding, /unloaded/)
  await pool.close()
  await unloaded
  await assert.rejects(pool.run({}, options(""), signal()), /closed/)
})

test("pre-aborted work never launches", async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(new WorkerPool().run({}, options(""), controller.signal), /abort/i)
})

test("oversized and circular requests fail before launching", async () => {
  const pool = new WorkerPool()
  await assert.rejects(pool.run({ query: "x".repeat(2 * 1024 * 1024) }, options(""), signal()), /2 MiB/)
  const circular: { self?: unknown } = {}
  circular.self = circular
  await assert.rejects(pool.run(circular, options(""), signal()), /circular/i)
  await pool.close()
})

test("representative 2000-path inventory request reaches an actual worker", async () => {
  const pool = new WorkerPool()
  const request = {
    operation: "search", root: "/synthetic/workspace", query: "calibration", mode: "lexical", limit: 5,
    allowed_paths: Array.from({ length: 2000 }, (_, i) => `packages/synthetic-component-${i}/documentation/calibration-guide-${i}.md`),
  }
  assert.ok(Buffer.byteLength(JSON.stringify(request)) > 64 * 1024)
  try {
    const result = await pool.run(request, options("let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const r=JSON.parse(s);console.log(JSON.stringify({count:r.allowed_paths.length,last:r.allowed_paths.at(-1)}))})"), signal())
    assert.deepEqual(result, { count: 2000, last: request.allowed_paths.at(-1) })
  } finally { await pool.close() }
})

test("worker environment allows OS paths but never credentials or source configuration", async () => {
  const source = {
    PATH: "/synthetic/system/bin", HOME: "/synthetic/home", TMPDIR: "/synthetic/tmp", LANG: "en_US.UTF-8",
    XDG_CONFIG_HOME: "/synthetic/config",
    OPENAI_API_KEY: "synthetic-key", ANTHROPIC_API_KEY: "synthetic-key", HF_TOKEN: "synthetic-key",
    AWS_SECRET_ACCESS_KEY: "synthetic-key", GITHUB_TOKEN: "synthetic-key", CUSTOM_PASSWORD: "synthetic-key",
    OPENCODE_CONFIG_CONTENT: "synthetic-config", OPENCODE_CONFIG: "/synthetic/source-config",
    OPEN_ENHANCE_HOME: "/wrong/home", PYTHONPATH: "/synthetic/injection", NODE_OPTIONS: "--synthetic",
    DYLD_INSERT_LIBRARIES: "/synthetic/injection", HTTPS_PROXY: "https://synthetic:credential@proxy.invalid",
  }
  const env = createWorkerEnvironment("/synthetic/repository", "/synthetic/data", source)
  assert.equal(env.PATH?.split(path.delimiter)[0], "/synthetic/repository/.pixi/envs/default/bin")
  assert.equal(env.HOME, source.HOME)
  assert.equal(env.XDG_CONFIG_HOME, source.XDG_CONFIG_HOME)
  assert.equal(env.OPEN_ENHANCE_HOME, "/synthetic/data")
  for (const key of Object.keys(source)) {
    if (!["PATH", "HOME", "TMPDIR", "LANG", "XDG_CONFIG_HOME", "OPEN_ENHANCE_HOME"].includes(key)) assert.equal(env[key], undefined, key)
  }
  const pool = new WorkerPool()
  try {
    const actual = await pool.run({}, options("process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify(process.env)))", { env }), signal())
    // CoreFoundation can add this OS-owned encoding hint after process launch.
    if (process.platform === "darwin") delete (actual as NodeJS.ProcessEnv).__CF_USER_TEXT_ENCODING
    assert.deepEqual(actual, env)
  } finally { await pool.close() }
})

test("SIGTERM-resistant worker is killed and reaped", async () => {
  const pool = new WorkerPool()
  const start = performance.now()
  await assert.rejects(pool.run({}, options("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", { timeoutMs: 200 }), signal()), /timed out/)
  assert.ok(performance.now() - start < 3000)
  await pool.close()
})
