// Reports whether oc-enhance is ready on this computer. Read-only.
import { access, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Backend, platformKey } from "../plugin/backend.ts"
import { dataDirectory, SettingsStore } from "../plugin/settings.ts"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const checks = []
const check = async (label, fn) => { try { checks.push([true, label, (await fn()) ?? ""]) } catch (error) { checks.push([false, label, error.message]) } }

await check("platform", async () => {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error(`unsupported: ${process.platform}`)
  return `${platformKey()}, node ${process.versions.node}`
})
await check("GUI bundle built", async () => { await access(join(root, "dist", "gui-experimental.cjs")); return "dist/gui-experimental.cjs" })
await check("settings", async () => JSON.stringify((await SettingsStore.open(dataDirectory())).current()))
await check("meaning-based search", async () => {
  const status = await new Backend(join(dataDirectory(), "search")).status()
  if (!status.supported) return `not available for ${status.platform} (keyword search works)`
  return status.installed ? "installed" : "not downloaded (Settings → Enhance → Download, or pixi run setup-search --user); keyword search works"
})
await check("installed snapshot", async () => {
  const { releasesDir, verifyRelease } = await import("./install.mjs")
  let state = {}
  try { state = JSON.parse(await readFile(join(releasesDir(), "installation.json"), "utf8")) } catch {}
  if (!state.current) return "not installed (pixi run install)"
  if (state.dev) return `development link: ${state.current}`
  const manifest = await verifyRelease(state.current)
  return `${state.current} (${Object.keys(manifest.files).length} files intact)`
})
for (const [ok, label, detail] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`)
process.exit(checks.every(([ok]) => ok) ? 0 : 1)
