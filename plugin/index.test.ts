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
    tool: { transform: async (callback: (editor: { add: (tool: Info) => void }) => void) => callback({ add: (tool) => tools.push(tool) }) },
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

test("opt-in older hosts fail closed before registering tools", async () => {
  const m = mock({ evidence: true })
  m.context.permission = {} as typeof m.context.permission
  await assert.rejects(async () => setup(createPlugin(), m.context), /lacks permission.assert/)
  assert.equal(m.tools.length, 0)
})

test("registers only the two custom tools; data directory must be absolute", async () => {
  const m = mock({ evidence: true })
  const cleanup = await setup(createPlugin(), m.context)
  assert.deepEqual(m.tools.map((tool) => tool.name), ["open_enhance_search", "open_enhance_read"])
  if (cleanup) await cleanup()
  await assert.rejects(async () => setup(createPlugin(), mock({ evidence: true, dataDirectory: "relative" }).context), /absolute/)
})

test("uses invoking session root and checks whole workspace plus original returned file", async () => {
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
    assert.deepEqual(m.approvals, [`${actualRoot}/**`, path.join(actualRoot, "fixture.txt"), path.join(actualRoot, "fixture.txt")])
    assert.deepEqual(JSON.parse(String(result.content)).allowed_paths, ["fixture.txt"])
    assert.equal(result.metadata?.groundTruth, "untrusted")
    if (cleanup) await cleanup()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("child read denies block search before worker launch or broad approval", async () => {
  const m = mock({ evidence: true })
  m.state.root = process.cwd()
  m.rules.push({ action: "read", resource: "**/private/**", effect: "deny" })
  let launched = false
  const cleanup = await setup(createPlugin({ worker: () => { launched = true; throw new Error("must not launch") } }), m.context)
  await assert.rejects(m.tools[0]!.execute({ query: "synthetic" }, invocation()), /read-deny/)
  assert.equal(launched, false)
  assert.deepEqual(m.approvals, [])
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

test("inventory file permission denial prevents search/index worker invocation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-enhance-inventory-"))
  try {
    await writeFile(path.join(root, "private.txt"), "synthetic denied source: never read by fake inventory")
    const m = mock({ evidence: true })
    m.state.root = root
    let workerCalls = 0
    let assertions = 0
    const denial = new Error("source permission denied")
    m.context.permission.assert = async (request) => {
      assertions++
      if (assertions === 2) {
        assert.ok(request.resources[0]?.endsWith("/private.txt"))
        throw denial
      }
    }
    const cleanup = await setup(createPlugin({ worker: () => {
      workerCalls++
      assert.equal(workerCalls, 1, "search worker must not launch after denial")
      return {
        executable: process.execPath, cwd: root,
        args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({paths:['private.txt']})))"],
      }
    } }), m.context)
    await assert.rejects(m.tools[0]!.execute({ query: "private" }, invocation()), (error) => error === denial)
    assert.equal(workerCalls, 1)
    assert.equal(assertions, 2)
    if (cleanup) await cleanup()
  } finally { await rm(root, { recursive: true, force: true }) }
})
