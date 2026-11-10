// Downloads and checks the meaning-based search engine (about 290 MB, pinned checksums).
//   pixi run setup-search            into this checkout's .local/search (for tests)
//   pixi run setup-search --user     into your oc-enhance data folder (what the plugin uses; same as Settings → Enhance → Download)
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Backend } from "../plugin/backend.ts"
import { dataDirectory } from "../plugin/settings.ts"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const target = process.argv.includes("--user") ? join(dataDirectory(), "search") : join(root, ".local", "search")
const backend = new Backend(target)
console.log(`Installing the search engine into ${target} ...`)
const timer = setInterval(async () => { const status = await backend.status(); if (status.installing) console.log(`  ${status.installing.step} (${status.installing.done + 1}/${status.installing.total})`) }, 5000)
try {
  await backend.install()
  const runtime = await backend.runtime()
  console.log(`Ready: ${runtime.colgrep}`)
} finally { clearInterval(timer) }
