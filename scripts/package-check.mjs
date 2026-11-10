import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

const result = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", "--cache", ".local/npm-cache"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }))[0]
const names = result.files.map(file => file.path)
if (!names.includes("vendor/gitlab-ai-provider-6.23.1-open-enhance.1.tgz")) throw new Error("Missing vendored provider migration")
for (const name of names) {
  if (name.split("/").some(part => part.startsWith(".") || ["node_modules", "__pycache__", "tests"].includes(part)) || name.includes(".test.") || name.endsWith(".pyc")) throw new Error(`Unsafe package member: ${name}`)
}
for (const required of ["plugin/index.ts", "plugin/rpc.ts", "plugin/checkpoint.ts", "dist/gui-experimental.cjs", "pixi.toml", "pixi.lock", "pyproject.toml", "models.lock.json", "npm-shrinkwrap.json", "src/open_enhance/cli.py", "src/open_enhance/document_worker.py"]) {
  if (!names.includes(required)) throw new Error(`Missing package member: ${required}`)
}
mkdirSync(".local/release", { recursive: true, mode: 0o700 })
const report = { schema: 1, check: "package-contents", passed: true, files: names.length, unpackedBytes: result.unpackedSize, manifestSha256: createHash("sha256").update(JSON.stringify(names.sort())).digest("hex") }
writeFileSync(path.join(".local/release", "package-check.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
console.log(JSON.stringify(report))
