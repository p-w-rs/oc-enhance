import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

export function releaseFingerprint(root = process.cwd()) {
  const files = []
  for (const directory of ["plugin", "src/open_enhance", "scripts", "docs", "tests", "dist", "vendor"]) {
    function walk(relative) {
      let entries
      try { entries = readdirSync(path.join(root, relative), { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "__pycache__") continue
        const name = path.posix.join(relative, entry.name)
        if (entry.isDirectory()) walk(name)
        else if (entry.isFile() && !entry.name.endsWith(".pyc")) files.push(name)
      }
    }
    walk(directory)
  }
  files.push("package.json", "npm-shrinkwrap.json", "pixi.toml", "pixi.lock", "pyproject.toml", "models.lock.json", "README.md", "tsconfig.json", "vite.config.ts")
  const hash = createHash("sha256")
  for (const name of files.sort()) { hash.update(name); hash.update("\0"); hash.update(readFileSync(path.join(root, name))); hash.update("\0") }
  return hash.digest("hex")
}
