import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import { createPlugin } from "./index.js"

function mock(options: Record<string, unknown> = {}) {
  const tools: Info[] = []
  const approvals: string[] = []
  const rules: { action: string; effect: string; resource: string }[] = []
  const state = { root: "/session/source" }
  const context = {
    options, location: { directory: "/wrong/plugin/location" },
    permission: { assert: async (input: { resources: string[] }) => { approvals.push(...input.resources) } },
    session: { get: async () => ({ location: { directory: state.root }, permissions: rules }) },
    agent: { get: async () => ({ data: { permissions: [] } }) },
    tool: { transform: async (callback: (editor: { add: (tool: Info) => void }) => void) => { callback({ add: (tool) => tools.push(tool) }); return { dispose: async () => {} } } },
  }
  return { context, tools, approvals, state, rules }
}
const invocation = () => ({ sessionID: "session", agent: "build", messageID: "message", id: "call", signal: new AbortController().signal, progress: async () => {} }) as unknown as ToolContext
const setup = (plugin: Plugin.Plugin, context: unknown) => plugin.setup(context as Plugin.Context)

test("evidence is disabled by default, even on older hosts", async () => {
  const m = mock()
  delete (m.context as { permission?: unknown }).permission
  await setup(createPlugin(), m.context)
  assert.equal(m.tools.length, 0)
})

test("missing evidence permission API disables evidence without failing plugin setup", async () => {
  const m = mock({ evidence: true })
  m.context.permission = {} as typeof m.context.permission
  await setup(createPlugin(), m.context)
  assert.equal(m.tools.length, 0)
})

test("registers only the two custom tools; data directory must be absolute", async () => {
  const m = mock({ evidence: true })
  const cleanup = await setup(createPlugin(), m.context)
  assert.deepEqual(m.tools.map((tool) => tool.name), ["open_enhance_search", "open_enhance_read"])
  if (cleanup) await cleanup()
  const invalid = mock({ evidence: true, dataDirectory: "relative" })
  await setup(createPlugin(), invalid.context)
  assert.equal(invalid.tools.length, 0)
})

test("uses invoking session root with directory inventory and exact source approvals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-enhance-adapter-"))
  try {
    await writeFile(path.join(root, "fixture.txt"), "synthetic")
    const m = mock({ evidence: true })
    m.state.root = root
    const cleanup = await setup(createPlugin({ worker: () => ({
      executable: process.execPath, cwd: root,
      args: ["-e", `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{let i=JSON.parse(s);console.log(JSON.stringify(i.operation==='inventory'?{paths:['fixture.txt']}:{root:i.root,allowed_paths:i.allowed_paths,results:[{evidence:{path:'fixture.txt',sha256:'a'.repeat(64),locator:{line_start:1,line_end:1}}}]}))})`],
    }) }), m.context)
    const result = await m.tools[0]!.execute({ query: "synthetic" }, invocation())
    const actualRoot = JSON.parse(String(result.content)).root
    assert.notEqual(actualRoot, m.context.location.directory)
    assert.deepEqual(m.approvals, [actualRoot, path.join(actualRoot, "fixture.txt"), path.join(actualRoot, "fixture.txt")])
    assert.deepEqual(JSON.parse(String(result.content)).allowed_paths, ["fixture.txt"])
    assert.equal(result.metadata?.groundTruth, "untrusted")
    if (cleanup) await cleanup()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("an unrelated read deny no longer prevents a permitted single-source read", async () => {
  const m = mock({ evidence: true })
  m.state.root = process.cwd()
  m.rules.push({ action: "read", resource: "**/private/**", effect: "deny" })
  const cleanup = await setup(createPlugin({ worker: () => ({ executable: process.execPath, cwd: process.cwd(), args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log('{}'))"] }) }), m.context)
  await m.tools[1]!.execute({ evidence: { path: "README.md", sha256: "a".repeat(64), locator: {} } }, invocation())
  assert.ok(m.approvals.every(file => file.endsWith("README.md")))
  if (cleanup) await cleanup()
})

test("read rejects path traversal before executing worker", async () => {
  const m = mock({ evidence: true })
  m.state.root = process.cwd()
  const cleanup = await setup(createPlugin(), m.context)
  await assert.rejects(m.tools[1]!.execute({ evidence: { path: "../outside", sha256: "a".repeat(64), locator: { line_start: 1 } } }, invocation()), /escapes/)
  if (cleanup) await cleanup()
})

test("permission rejection propagates before indexing", async () => {
  const m = mock({ evidence: true })
  m.state.root = process.cwd()
  let launched = false
  const denial = new Error("denied by user")
  m.context.permission.assert = async () => { throw denial }
  const cleanup = await setup(createPlugin({ worker: () => { launched = true; throw new Error("must not launch") } }), m.context)
  await assert.rejects(m.tools[0]!.execute({ query: "synthetic" }, invocation()), (error) => error === denial)
  assert.equal(launched, false)
  if (cleanup) await cleanup()
})

test("evidence read uses its session root, passes token unchanged, checks file twice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-enhance-read-"))
  try {
    await writeFile(path.join(root, "fixture.txt"), "synthetic")
    const m = mock({ evidence: true })
    m.state.root = root
    const cleanup = await setup(createPlugin({ worker: () => ({
      executable: process.execPath, cwd: root,
      args: ["-e", "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(s))"],
    }) }), m.context)
    const token = { path: "fixture.txt", sha256: "a".repeat(64), locator: { line_start: 1, line_end: 1 } }
    const result = await m.tools[1]!.execute({ evidence: token }, invocation())
    const request = JSON.parse(String(result.content))
    assert.equal(request.operation, "read")
    assert.deepEqual(request.evidence, token)
    assert.deepEqual(m.approvals, [path.join(request.root, token.path), path.join(request.root, token.path)])
    if (cleanup) await cleanup()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("evidence symlinks outside source workspace fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-enhance-link-"))
  try {
    await symlink(process.execPath, path.join(root, "outside"))
    const m = mock({ evidence: true })
    m.state.root = root
    const cleanup = await setup(createPlugin(), m.context)
    await assert.rejects(m.tools[1]!.execute({ evidence: { path: "outside", sha256: "a".repeat(64), locator: {} } }, invocation()), /symlink escapes/)
    if (cleanup) await cleanup()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("native rule-denied inventory sources are excluded while permitted sources are searched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-enhance-inventory-"))
  try {
    await writeFile(path.join(root, "private.txt"), "synthetic denied source: never read by fake inventory")
    await writeFile(path.join(root, "public.txt"), "synthetic public source")
    const m = mock({ evidence: true })
    m.state.root = root
    let workerCalls = 0
    let assertions = 0
    m.context.permission.assert = async (request) => {
      assertions++
      if (request.resources[0]?.endsWith("/private.txt")) throw { _tag: "Tool.Error", error: { _tag: "Permission.BlockedError" } }
    }
    const cleanup = await setup(createPlugin({ worker: () => {
      workerCalls++
      return {
        executable: process.execPath, cwd: root,
        args: ["-e", "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{let i=JSON.parse(s);console.log(JSON.stringify(i.operation==='inventory'?{paths:['private.txt','public.txt']}:{allowed:i.allowed_paths,results:[]}))})"],
      }
    } }), m.context)
    const result = JSON.parse(String((await m.tools[0]!.execute({ query: "synthetic" }, invocation())).content))
    assert.deepEqual(result.allowed, ["public.txt"])
    assert.deepEqual(result.authorization, { authorized_files: 1, denied_files: 1 })
    assert.equal(workerCalls, 2)
    assert.equal(assertions, 3)
    if (cleanup) await cleanup()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("legacy pixiGuard option installs no enforcement or system instruction hooks", async () => {
  const m = mock({ pixiGuard: true })
  await setup(createPlugin(), m.context)
  assert.deepEqual(m.tools, [])
  assert.deepEqual(m.approvals, [])
})

test("evidence setup failure preserves independent checkpoint tools and controls", async () => {
  const m = mock({ checkpoints: true, evidence: true })
  const db = new Map<string, unknown>(), hooks: string[] = []
  const register = async (name: string) => { hooks.push(name); return { dispose: async () => {} } }
  const context = {
    ...m.context, permission: {},
    storage: { get: async (key: string) => db.get(key), set: async (key: string, value: unknown) => { db.set(key, structuredClone(value)) } },
    session: { ...m.context.session, hook: register },
    tool: { ...m.context.tool, hook: register },
    command: { transform: async () => ({ dispose: async () => {} }) },
    rpc: { register: async () => ({ dispose: async () => {} }) },
  }
  const cleanup = await setup(createPlugin(), context)
  assert.deepEqual(m.tools.map(tool => tool.name), ["open_enhance_checkpoint", "open_enhance_handoff"])
  assert.ok(hooks.includes("execute.before"))
  if (cleanup) await cleanup()
})
