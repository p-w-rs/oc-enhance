import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { parse } from "jsonc-parser"
import { configure, featureOptions, findHost, verifySnapshot } from "../scripts/install.mjs"

test("installer preserves JSONC, unrelated settings and existing feature options and is idempotent", () => {
  const source = '{\n// keep this comment\n"model":"synthetic/model",\n"plugins":["another-plugin",{"package":"/data/releases/old","options":{"evidence":true,"dataDirectory":"/synthetic/data"}}],\n}\n'
  const updated = configure(source, "/data/releases/new", "/data/releases", { checkpoints: true, pixiExecutable: "/tools/pixi" })
  assert.match(updated, /keep this comment/)
  const config = parse(updated)
  assert.equal(config.model, "synthetic/model")
  assert.equal(config.plugins[0], "another-plugin")
  assert.deepEqual(config.plugins[1], { package: "/data/releases/new", options: { evidence: true, dataDirectory: "/synthetic/data", checkpoints: true, pixiExecutable: "/tools/pixi" } })
  assert.equal(configure(updated, "/data/releases/new", "/data/releases", { checkpoints: true, pixiExecutable: "/tools/pixi" }), updated)
})

test("installer handles fresh config, owned duplicates and uninstall without selecting a model", () => {
  const fresh = parse(configure('{}', '/data/releases/new', '/data/releases', { checkpoints: true }))
  assert.deepEqual(fresh.plugins, [{ package: '/data/releases/new', options: { checkpoints: true } }])
  assert.equal(fresh.model, undefined)
  const source = JSON.stringify({ plugins: ["/data/releases/a", "other", "/data/releases/b", "/data/releases-other/user-work"] })
  const updated = parse(configure(source, '/data/releases/new', '/data/releases'))
  assert.equal(updated.plugins.length, 3)
  assert.deepEqual(parse(configure(source, undefined, '/data/releases')).plugins, ['other', '/data/releases-other/user-work'])
  for (const invalid of ['{bad', '[]', '{"plugins":{}}', '{"plugins":[{"package":"/data/releases/a","options":[]}]}']) {
    assert.throws(() => configure(invalid, '/data/releases/new', '/data/releases'))
  }
})

test("installer explicitly disables features and removes obsolete global guard configuration", () => {
  const source = JSON.stringify({ plugins: [{ package: "/data/releases/old", options: { pixiGuard: true, evidence: true, checkpoints: true } }] })
  const options = featureOptions(["--no-evidence", "--checkpoints"])
  assert.deepEqual(options, { evidence: false, checkpoints: true })
  const config = parse(configure(source, "/data/releases/new", "/data/releases", options))
  assert.deepEqual(config.plugins[0].options, { evidence: false, checkpoints: true })
  assert.throws(() => featureOptions(["--evidence", "--no-evidence"]), /not both/)
})

test("installer discovers compatible Desktop even when PATH CLI is old, rejecting V1 and malformed versions", () => {
  const versions: Record<string, string> = { old: 'opencode v2.0.18', desktop: 'opencode v2.2.6', v1: '1.2.3', junk: 'unknown', future: 'opencode v3.0.0' }
  const run = (command: string) => versions[command] ?? (() => { throw new Error('missing') })()
  assert.equal(findHost(['old', 'missing', 'desktop'], run).command, 'desktop')
  assert.throws(() => findHost(['old', 'v1', 'junk', 'future'], run), /Requires OpenCode/)
})

test("installed snapshot verification rejects tampering and unsafe manifests", async () => {
  await mkdir('.local', { recursive: true })
  const directory = await mkdtemp(path.resolve('.local/install-test-'))
  try {
    const files: Record<string, string> = {}
    for (const name of ['plugin/index.ts', 'dist/gui-experimental.cjs']) {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true })
      await writeFile(path.join(directory, name), 'synthetic')
      files[name] = createHash('sha256').update('synthetic').digest('hex')
    }
    const manifest = path.join(directory, '.open-enhance-release.json')
    await writeFile(manifest, JSON.stringify({ files }))
    await verifySnapshot(directory)
    await writeFile(path.join(directory, 'plugin/index.ts'), 'changed')
    await assert.rejects(verifySnapshot(directory), /Snapshot changed/)
    await writeFile(manifest, JSON.stringify({ files: { '../outside': 'bad' } }))
    await assert.rejects(verifySnapshot(directory), /Incomplete snapshot/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
