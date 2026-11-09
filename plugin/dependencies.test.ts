import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createRequire } from "node:module"

// Resolve the same dependencies as the actual OpenCode util consumer, not an
// unrelated top-level version that happens to make an audit report look clean.
const require = createRequire(import.meta.resolve("@opencode/util/glob"))
const { glob } = require("glob") as typeof import("glob")
const { Minimatch } = require("minimatch") as typeof import("minimatch")

test("remediated glob stops traversing after cancellation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oe-glob-regression-"))
  try {
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) await mkdir(path.join(root, `${a}`, `${b}`, `${c}`), { recursive: true })
    const controller = new AbortController()
    let reads = 0
    const customFs = { ...fs, readdir: (...args: any[]) => {
      reads++
      const callback = args.pop()
      ;(fs.readdir as (...args: any[]) => void)(...args, (error: unknown, entries: unknown) => {
        if (!controller.signal.aborted) controller.abort(new Error("synthetic cancellation"))
        setTimeout(() => callback(error, entries), 1)
      })
    } }
    await assert.rejects(glob("**/*", { cwd: root, fs: customFs as any, signal: controller.signal }), /synthetic cancellation/)
    const atRejection = reads
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(reads, atRejection, "no further directory reads after cancellation rejects")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("remediated minimatch bounds globpart amplification", () => {
  assert.throws(() => new Minimatch("**/../a/b/".repeat(8) + "x", { optimizationLevel: 2, braceExpandMax: 32 }), RangeError)
})

test("OpenCode util retains glob scan and match contracts after scoped migration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oe-util-glob-"))
  try {
    await mkdir(path.join(root, "src"))
    await writeFile(path.join(root, "src", "probe.ts"), "synthetic\n")
    await writeFile(path.join(root, ".hidden.ts"), "synthetic\n")
    const { Glob } = await import("@opencode/util/glob")
    assert.deepEqual((await Glob.scan("**/*.ts", { cwd: root, dot: true })).sort(), [".hidden.ts", "src/probe.ts"])
    assert.equal(Glob.match("src/**/*.ts", "src/probe.ts"), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
