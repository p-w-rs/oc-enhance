import { after, test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Backend } from "./backend.js"
import { inventory, keywordRank, ProjectIndex, textUnits } from "./search.js"
import { docx, pptx } from "./testdocs.js"

const dirs: string[] = []
after(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })
const scratch = async () => { const dir = await mkdtemp(join(tmpdir(), "oce-search-")); dirs.push(dir); return dir }

async function project() {
  const root = await scratch()
  const files: Record<string, string | Uint8Array> = {
    "README.md": "# Billing service\n\nHandles invoices and refunds.\n",
    "src/sessions.ts": "export function evictIdleSessions(store: Store) {\n  // remove sessions idle for more than 30 minutes\n}\n",
    "src/retry.ts": "export const retryDelayMs = 250\n",
    "docs/travel-policy.docx": docx(["Travel policy", "Employees may claim a hotel and meals when a flight is cancelled overnight."]),
    "docs/q3.pptx": pptx([{ text: ["Q3 review"] }, { text: ["Churn fell to 2%"] }]),
    ".env": "TOKEN=secret",
    "secrets.json": "{}",
    "node_modules/x/index.js": "x",
    "build/out.js": "generated",
    "ignored/notes.md": "should be ignored",
    "logo.png": new Uint8Array([137, 80, 78, 71]),
    ".gitignore": "ignored/\n",
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

test("inventory: text, code and documents; skips hidden, secret-looking, generated, ignored and binary files", async () => {
  const root = await project()
  const found = await inventory(root)
  assert.deepEqual(found.files, ["docs/q3.pptx", "docs/travel-policy.docx", "README.md", "src/retry.ts", "src/sessions.ts"])
  assert.deepEqual((await inventory(root, "src")).files, ["src/retry.ts", "src/sessions.ts"])
})

test("line windows keep line numbers", () => {
  const units = textUnits(Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"))
  assert.deepEqual(units.map(u => u.where), ["lines 1-60", "lines 46-100"])
  assert.equal(units[1]!.text.split("\n")[0], "line 46")
})

test("keyword ranking splits camelCase and prefers rarer terms", () => {
  const ranked = keywordRank([{ key: "a", path: "a.ts", text: "retryDelayMs = 250" }, { key: "b", path: "b.ts", text: "delay delay other" }], "retry delay", 5)
  assert.equal(ranked[0]![0], "a")
})

test("keyword search over code and documents; index stays outside the project and updates incrementally", async () => {
  const root = await project()
  const indexes = await scratch()
  const index = new ProjectIndex(indexes, root)
  const first = await index.search("flight cancelled hotel", { mode: "keyword" })
  assert.equal(first.mode, "keyword")
  assert.equal(first.results[0]!.path, "docs/travel-policy.docx")
  assert.match(first.results[0]!.where, /paragraphs 1-2/)
  assert.equal(first.coverage.files, 5)
  assert.deepEqual((await readdir(root)).sort(), [".env", ".gitignore", "README.md", "build", "docs", "ignored", "logo.png", "node_modules", "secrets.json", "src"], "nothing was written into the project")
  const churn = await index.search("churn", { mode: "keyword" })
  assert.equal(churn.results[0]!.where, "slide 2")
  await writeFile(join(root, "src", "retry.ts"), "export const backoffJitter = true\n")
  await rm(join(root, "README.md"))
  const after = await index.search("backoff jitter", { mode: "keyword" })
  assert.equal(after.results[0]!.path, "src/retry.ts")
  assert.equal(after.coverage.files, 4, "deleted file dropped")
  assert.equal((await index.search("invoices", { mode: "keyword" })).results.length, 0)
})

test("without the search engine, auto falls back to keywords and says how to get meaning-based search", async () => {
  const root = await project()
  const output = await new ProjectIndex(await scratch(), root).search("where are idle sessions removed")
  assert.equal(output.mode, "keyword")
  assert.match(output.note!, /Settings → Enhance/)
  assert.equal(output.results[0]!.path, "src/sessions.ts")
})

test("meaning-based search with the real engine (when downloaded via pixi run setup-search)", async t => {
  const backend = new Backend(join(import.meta.dirname, "..", ".local", "search"))
  const runtime = await backend.runtime()
  if (!runtime) return t.skip("search engine not downloaded (pixi run setup-search)")
  const root = await project()
  const index = new ProjectIndex(await scratch(), root)
  const output = await index.search("what happens if my flight is cancelled", { runtime })
  assert.equal(output.mode, "semantic")
  assert.equal(output.results[0]!.path, "docs/travel-policy.docx")
  const code = await index.search("where do we clean up inactive users' sessions", { runtime })
  assert.equal(code.results[0]!.path, "src/sessions.ts")
  const hybrid = await index.search("retry delay", { runtime, mode: "hybrid" })
  assert.equal(hybrid.results[0]!.path, "src/retry.ts")
})
