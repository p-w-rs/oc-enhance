import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile, copyFile, chmod, rename, unlink, readdir } from "node:fs/promises"
import { homedir, release } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse, modify, applyEdits } from "jsonc-parser"

const digest = data => createHash("sha256").update(data).digest("hex")
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)))

export function findHost(candidates, run = execFileSync) {
  for (const command of candidates) {
    let version
    try { version = run(command, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim() } catch { continue }
    const match = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/.exec(version)
    if (match && +match[1] === 2 && (+match[2] > 2 || (+match[2] === 2 && +match[3] >= 6))) return { command, version }
  }
  throw new Error("Requires OpenCode V2 >=2.2.6 (tested with 2.2.6). Install Desktop or put a compatible CLI on PATH; no configuration changed.")
}

export function configure(source, target, releases, options = {}, sourceRoot = root) {
  const errors = []
  const config = parse(source, errors, { allowTrailingComma: true })
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid OpenCode configuration; refusing to overwrite")
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) throw new Error("Expected a V2 plugins array")
  const plugins = config.plugins ?? []
  const owned = value => {
    const name = typeof value === "string" ? value : value?.package
    return typeof name === "string" && (name === sourceRoot || name.startsWith(`${releases}${path.sep}`))
  }
  const previous = plugins.find(owned)
  const existingOptions = typeof previous === "object" ? previous.options ?? {} : {}
  if (!existingOptions || typeof existingOptions !== "object" || Array.isArray(existingOptions)) throw new Error("Invalid existing plugin options")
  const entry = { ...(typeof previous === "object" ? previous : {}), package: target, options: { ...existingOptions, ...options } }
  delete entry.options.pixiGuard // Removed globally; stale opt-ins must not resurrect it.
  const indices = plugins.flatMap((value, index) => owned(value) ? [index] : [])
  // Patch array entries rather than serializing the document: preserve JSONC comments.
  const format = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
  if (target && indices.length === 1 && JSON.stringify(plugins[indices[0]]) === JSON.stringify(entry)) return source
  if (!target && !indices.length) return source
  let updated = source
  let expected
  if (!Array.isArray(config.plugins)) expected = [entry]
  else if (!indices.length) expected = [...plugins, entry]
  else expected = plugins.flatMap((value, index) => !indices.includes(index) ? [value] : target && index === indices[0] ? [entry] : [])
  if (target && Array.isArray(config.plugins) && indices.length === 1) updated = applyEdits(updated, modify(updated, ["plugins", indices[0]], entry, format))
  else if (target && Array.isArray(config.plugins) && !indices.length) updated = applyEdits(updated, modify(updated, ["plugins", plugins.length], entry, format))
  // jsonc-parser 3.3.1 corrupts single-line arrays when removing an element, so removals rewrite the whole
  // plugins array (comments inside that array are lost; the rest of the document is kept).
  else updated = applyEdits(updated, modify(updated, ["plugins"], expected, format))
  const updatedErrors = []
  const reparsed = parse(updated, updatedErrors, { allowTrailingComma: true })
  if (updatedErrors.length || JSON.stringify(reparsed?.plugins) !== JSON.stringify(expected)) throw new Error("Configuration edit failed validation; no configuration changed")
  return updated
}

export async function verifySnapshot(directory) {
  const receipt = JSON.parse(await readFile(path.join(directory, ".open-enhance-release.json"), "utf8"))
  if (!receipt.files?.["plugin/index.ts"] || !receipt.files?.["dist/gui-experimental.cjs"]) throw new Error("Incomplete snapshot integrity manifest")
  for (const [name, expected] of Object.entries(receipt.files)) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw new Error("Invalid snapshot member")
    if (digest(await readFile(path.join(directory, name))) !== expected) throw new Error(`Snapshot changed: ${name}`)
  }
  return receipt
}

async function snapshot(releases, pixi, dataDirectory) {
  const destination = path.join(root, ".local/release")
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination, "--cache", ".local/npm-cache"], { cwd: root, encoding: "utf8" }))[0]
  const archive = path.join(destination, packed.filename)
  const archiveSha256 = digest(await readFile(archive))
  const directory = path.join(releases, `${packed.version}-${archiveSha256.slice(0, 16)}`)
  await mkdir(releases, { recursive: true, mode: 0o700 })
  try { await mkdir(directory, { mode: 0o700 }) }
  catch (error) {
    if (error.code !== "EEXIST") throw error
    const receipt = await verifySnapshot(directory)
    if (receipt.archiveSha256 !== archiveSha256) throw new Error("Snapshot archive fingerprint mismatch")
    return directory
  }
  // Never relocate a prepared Pixi prefix or overwrite an existing snapshot.
  execFileSync("/usr/bin/tar", ["-xzf", archive, "--strip-components=1", "-C", directory])
  for (const task of ["setup", "doctor"]) execFileSync(pixi, ["run", "--locked", "--manifest-path", path.join(directory, "pixi.toml"), task], { cwd: directory, stdio: "inherit", timeout: 600_000, env: { ...process.env, ...(dataDirectory ? { OPEN_ENHANCE_HOME: dataDirectory } : {}) } })
  const files = {}
  for (const { path: name } of packed.files) files[name] = digest(await readFile(path.join(directory, name)))
  await writeFile(path.join(directory, ".open-enhance-release.json"), JSON.stringify({ archiveSha256, files }, null, 2) + "\n", { mode: 0o600 })
  await verifySnapshot(directory)
  return directory
}

export function featureOptions(args) {
  const options = {}
  for (const feature of ["checkpoints", "evidence", "terminals"]) {
    if (args.includes(`--${feature}`) && args.includes(`--no-${feature}`)) throw new Error(`Choose enable or disable for ${feature}, not both`)
    if (args.includes(`--${feature}`)) options[feature] = true
    if (args.includes(`--no-${feature}`)) options[feature] = false
  }
  return options
}

export async function install(args = process.argv.slice(2)) {
  const allowed = new Set(["--checkpoints", "--no-checkpoints", "--evidence", "--no-evidence", "--terminals", "--no-terminals", "--uninstall", "--rollback"])
  if (args.some(value => !allowed.has(value))) throw new Error("Usage: pixi run --locked install --[no-]checkpoints --[no-]evidence --[no-]terminals | --rollback | --uninstall. The --pixi-guard feature has been removed.")
  const features = featureOptions(args)
  const uninstall = args.includes("--uninstall"), rollback = args.includes("--rollback")
  if ((uninstall || rollback) && args.length !== 1) throw new Error("Choose one installation operation")
  if (!args.length) throw new Error("Choose features explicitly: --[no-]checkpoints, --[no-]evidence and/or --[no-]terminals")
  const configDirectory = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode")
  const releases = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share"), "open-enhance/releases")
  await mkdir(configDirectory, { recursive: true, mode: 0o700 })
  const lock = path.join(configDirectory, ".open-enhance-install.lock")
  await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 })
  try {
    let file = path.join(configDirectory, "opencode.jsonc"), source
    for (const name of ["opencode.jsonc", "opencode.json"]) {
      try { source = await readFile(path.join(configDirectory, name), "utf8"); file = path.join(configDirectory, name); break }
      catch (error) { if (error.code !== "ENOENT") throw error }
    }
    const existed = source !== undefined
    source ??= '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'
    configure(source, undefined, releases) // Fail before provisioning for malformed config.
    const stateFile = path.join(releases, "installation.json")
    let state = {}
    try { state = JSON.parse(await readFile(stateFile, "utf8")) } catch (error) { if (error.code !== "ENOENT") throw error }
    let target, options = {}
    if (!uninstall) {
      if (process.platform !== "darwin" || process.arch !== "arm64" || Number(release().split(".")[0]) < 24) throw new Error("Requires macOS 15+ on Apple Silicon")
      const desktop = path.join(homedir(), "Library/Application Support/ai.opencode.desktop/cli")
      let bundled = []
      try { bundled = (await readdir(desktop)).sort().reverse().map(name => path.join(desktop, name, "opencode-cli")) } catch (error) { if (error.code !== "ENOENT") throw error }
      const host = findHost([...bundled, "opencode"])
      console.log(`Compatible OpenCode: ${host.version}`)
      const pixi = execFileSync("/usr/bin/which", ["pixi"], { encoding: "utf8" }).trim()
      if (!path.isAbsolute(pixi)) throw new Error("Cannot locate Pixi")
      if (rollback) {
        if (!state.previous || path.dirname(state.previous) !== releases) throw new Error("No previous managed snapshot available")
        target = state.previous
        await verifySnapshot(target)
      } else {
        const previous = (parse(source).plugins ?? []).find(value => {
          const name = typeof value === "string" ? value : value?.package
          return name === root || (typeof name === "string" && name.startsWith(`${releases}${path.sep}`))
        })
        const dataDirectory = process.env.OPEN_ENHANCE_HOME || previous?.options?.dataDirectory
        if (dataDirectory !== undefined && (typeof dataDirectory !== "string" || !path.isAbsolute(dataDirectory))) throw new Error("Evidence data directory must be absolute")
        target = await snapshot(releases, pixi, dataDirectory)
        options = {
          ...features,
          pixiExecutable: pixi,
          ...(dataDirectory ? { dataDirectory } : {}),
        }
      }
    }
    const updated = configure(source, target, releases, options)
    if (updated !== source) {
      if (existed) {
        if (await readFile(file, "utf8") !== source) throw new Error("Configuration changed during install; retry")
        const backup = `${file}.open-enhance-${Date.now()}-${process.pid}.bak`
        await copyFile(file, backup); await chmod(backup, 0o600)
      } else {
        try { await readFile(file); throw new Error("Configuration appeared during install; retry") } catch (error) { if (error.code !== "ENOENT") throw error }
      }
      const temporary = `${file}.open-enhance-${process.pid}.tmp`
      await writeFile(temporary, updated, { flag: "wx", mode: 0o600 })
      await rename(temporary, file)
    }
    if (target && state.current !== target) {
      const temporary = `${stateFile}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify({ current: target, previous: state.current }, null, 2) + "\n", { mode: 0o600 })
      await rename(temporary, stateFile)
    }
    console.log(uninstall ? "Removed open-enhance config entry; snapshots, checkpoints and evidence data retained." : `Installed open-enhance: ${target}`)
    console.log("Unrelated settings preserved. OpenCode watches configuration; use /reload if needed.")
  } finally { await unlink(lock) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await install()
