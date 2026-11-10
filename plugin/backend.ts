// The meaning-based search engine: ColGrep (LightOn), ONNX Runtime (Microsoft) and the LateOn-Code-edge model,
// downloaded once per computer into <data>/search with pinned checksums. Nothing is installed system-wide.
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

export const COLGREP_VERSION = "1.8.5"
export const ORT_VERSION = "1.23.2"
export const MODEL = { repository: "lightonai/LateOn-Code-edge", revision: "4bcdf5ed93f791259eb130b577a240f753d68dd8", license: "Apache-2.0" }
const MODEL_FILES: Readonly<Record<string, string>> = {
  "config.json": "c1413b20ad05927b8226aa2223b3ae104cd04c8541fe1300bdcf455fc8667601",
  "onnx_config.json": "fa4fef89820dcdc33c5504c62c1d5efc19603cfbfebf02368a70d51a4dbe6651",
  "model.onnx": "ac5a92a685512b163c3c591438f518379309d2a98c4818a9c6e2986f789dc8ef",
  "model_int8.onnx": "eac35bdaa862e2762e6455337f7a3e704b05dbc4259f00929fcc8e10207f11c7",
  "tokenizer.json": "a388b94942e98e5c661c6c23f919842285738bfd123a0d148dea0c56287505d0",
  "tokenizer_config.json": "1621afee1f3dbc2c42901841ca46016c83102a8e070d32b90f80f80b214172a4",
  "special_tokens_map.json": "6edfb9d64c0d7e5cbaa53516e90280fe1f42ba5ea7923d005a5f9b6e082142cf",
  "sentence_bert_config.json": "fb7288b98b76cbd57650bc99cd902152eb045d0c8a9e30c274cf2a46f04fcf30",
  "config_sentence_transformers.json": "34942289dec20e285b07132aa1d09980ed776a0bc34e531dd7b49c4701876871",
  "modules.json": "930b80c6d74f342665da7c56d01a9d906176ba3c74dd9f332cea8922121c4bbf",
  "1_Dense/config.json": "778498303dd2b9b40b127a779f2ca2a49da8d6cf9d850492710c6db3cf7bb34b",
  "1_Dense/model.safetensors": "9efb17fcb2106cd8fcb01d57a9cd9c997a487ad20630ec8e44ce3f9d89efe0a7",
  "2_Dense/config.json": "468e536293d2aae980aac3577250d2d1305b562e30eafc782feefcf15a5a9ba8",
  "2_Dense/model.safetensors": "a7a388138b3c4bb1a81c8c3bcb9de123f1e652b9e9464a72707ca19ee86a26b1",
}
interface Platform { readonly colgrep: string; readonly colgrepSha256: string; readonly ort: string; readonly ortSha256: string }
const PLATFORMS: Readonly<Record<string, Platform>> = {
  "darwin-arm64": { colgrep: "aarch64-apple-darwin", colgrepSha256: "2cd013c820a6ba9d4066c58ce7e6b75ea614dd77a9a18a88836e005f1ef126bc", ort: "osx-arm64", ortSha256: "b4d513ab2b26f088c66891dbbc1408166708773d7cc4163de7bdca0e9bbb7856" },
  "darwin-x64": { colgrep: "x86_64-apple-darwin", colgrepSha256: "6f23777e87a7cee9c31846514bc0a70736df71f201abfff6aedb51dc27ec6c2a", ort: "osx-x86_64", ortSha256: "d10359e16347b57d9959f7e80a225a5b4a66ed7d7e007274a15cae86836485a6" },
  "linux-x64": { colgrep: "x86_64-unknown-linux-gnu", colgrepSha256: "532e1da739f6b5d489cdaefd20c5918fa1bb0ff9f456c89098eb49a6379ae205", ort: "linux-x64", ortSha256: "1fa4dcaef22f6f7d5cd81b28c2800414350c10116f5fdd46a2160082551c5f9b" },
  "linux-arm64": { colgrep: "aarch64-unknown-linux-gnu", colgrepSha256: "90ccb4132ca34c5202ca3d9789e722446dfed85b3be6247321ee55e1a909f34b", ort: "linux-aarch64", ortSha256: "7c63c73560ed76b1fac6cff8204ffe34fe180e70d6582b5332ec094810241e5c" },
}
const RUNTIME = `runtime-${COLGREP_VERSION}-${ORT_VERSION}-${MODEL.revision.slice(0, 8)}`

export interface Download { readonly name: string; readonly url: string; readonly sha256: string; readonly path: string }
export interface BackendStatus {
  readonly supported: boolean
  readonly installed: boolean
  readonly platform: string
  readonly installing?: { readonly step: string; readonly done: number; readonly total: number }
  readonly error?: string
}
export interface Runtime { readonly colgrep: string; readonly ort: string; readonly model: string; readonly home: string }

export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`

export function downloads(platform = platformKey()): Download[] {
  const spec = PLATFORMS[platform]
  if (!spec) throw new Error(`Meaning-based search is not available for ${platform}; keyword search still works`)
  return [
    { name: "search engine (ColGrep)", url: `https://github.com/lightonai/next-plaid/releases/download/v${COLGREP_VERSION}/colgrep-${spec.colgrep}.tar.xz`, sha256: spec.colgrepSha256, path: `colgrep-${spec.colgrep}.tar.xz` },
    { name: "ONNX Runtime", url: `https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-${spec.ort}-${ORT_VERSION}.tgz`, sha256: spec.ortSha256, path: `onnxruntime-${spec.ort}-${ORT_VERSION}.tgz` },
    ...Object.entries(MODEL_FILES).map(([file, sha256]) => ({ name: `model ${file}`, url: `https://huggingface.co/${MODEL.repository}/resolve/${MODEL.revision}/${file}`, sha256, path: `model/${file}` })),
  ]
}

const sha256File = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex")

async function fetchTo(url: string, path: string, sha256: string, signal?: AbortSignal): Promise<void> {
  try { if (await sha256File(path) === sha256) return } catch {}
  const response = await fetch(url, { redirect: "follow", ...(signal && { signal }) })
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`)
  const partial = `${path}.part`
  const hash = createHash("sha256")
  const body = Readable.fromWeb(response.body as never)
  body.on("data", (chunk: Buffer) => hash.update(chunk))
  await pipeline(body, createWriteStream(partial, { mode: 0o600 }))
  if (hash.digest("hex") !== sha256) { await rm(partial, { force: true }); throw new Error(`Checksum mismatch for ${url}; nothing was installed`) }
  await rename(partial, path)
}

const run = (command: string, args: string[], cwd: string) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  child.stderr.on("data", data => { stderr += data })
  child.on("error", reject)
  child.on("close", code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim().slice(-500)}`)))
})

async function find(directory: string, test: (name: string) => boolean): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && test(entry.name)) return path
    if (entry.isDirectory()) { const found = await find(path, test); if (found) return found }
  }
  return undefined
}

export class Backend {
  #installing?: { step: string; done: number; total: number }
  #error?: string
  #task?: Promise<void>
  constructor(readonly directory: string, readonly platform = platformKey()) {}

  get runtimeDir() { return join(this.directory, RUNTIME) }

  async runtime(): Promise<Runtime | undefined> {
    try {
      const receipt = JSON.parse(await readFile(join(this.runtimeDir, "receipt.json"), "utf8")) as { platform: string; colgrep: string; ort: string }
      if (receipt.platform !== this.platform) return undefined
      const result = { colgrep: join(this.runtimeDir, receipt.colgrep), ort: join(this.runtimeDir, receipt.ort), model: join(this.runtimeDir, "model"), home: join(this.directory, "home") }
      await Promise.all([stat(result.colgrep), stat(result.ort), stat(join(result.model, "model_int8.onnx"))])
      return result
    } catch { return undefined }
  }

  async status(): Promise<BackendStatus> {
    return {
      supported: this.platform in PLATFORMS, installed: !!(await this.runtime()), platform: this.platform,
      ...(this.#installing && { installing: { ...this.#installing } }), ...(this.#error && { error: this.#error }),
    }
  }

  /** Downloads, verifies and unpacks everything (about 290 MB). Safe to call again; finished downloads are reused. */
  install(signal?: AbortSignal): Promise<void> {
    this.#installing ??= { step: "Starting the download", done: 0, total: downloads(this.platform).length + 1 }
    this.#task ??= this.#install(signal).finally(() => { this.#task = undefined; this.#installing = undefined })
    return this.#task
  }

  async #install(signal?: AbortSignal): Promise<void> {
    this.#error = undefined
    try {
      const items = downloads(this.platform)
      const cache = join(this.directory, "downloads")
      await mkdir(join(cache, "model", "1_Dense"), { recursive: true, mode: 0o700 })
      await mkdir(join(cache, "model", "2_Dense"), { recursive: true, mode: 0o700 })
      for (const [index, item] of items.entries()) {
        this.#installing = { step: `Downloading ${item.name}`, done: index, total: items.length + 1 }
        await fetchTo(item.url, join(cache, item.path), item.sha256, signal)
      }
      this.#installing = { step: "Unpacking", done: items.length, total: items.length + 1 }
      const staging = join(this.directory, `.staging-${process.pid}-${Date.now()}`)
      await rm(staging, { recursive: true, force: true })
      await mkdir(join(staging, "unpack"), { recursive: true, mode: 0o700 })
      try {
        for (const item of items.slice(0, 2)) await run("tar", ["-xf", join(cache, item.path), "-C", join(staging, "unpack")], staging)
        const colgrep = await find(join(staging, "unpack"), name => name === "colgrep")
        const ort = await find(join(staging, "unpack"), name => /^libonnxruntime\.(\d+\.\d+\.\d+\.dylib|so\.\d+\.\d+\.\d+)$/.test(name))
        if (!colgrep || !ort) throw new Error("The downloaded archives did not contain the expected files")
        await mkdir(join(staging, "bin")); await mkdir(join(staging, "lib")); await mkdir(join(staging, "model", "1_Dense"), { recursive: true }); await mkdir(join(staging, "model", "2_Dense"))
        await copyFile(colgrep, join(staging, "bin", "colgrep")); await chmod(join(staging, "bin", "colgrep"), 0o755)
        const ortName = ort.split("/").pop()!
        await copyFile(ort, join(staging, "lib", ortName))
        for (const file of Object.keys(MODEL_FILES)) await copyFile(join(cache, "model", file), join(staging, "model", file))
        await rm(join(staging, "unpack"), { recursive: true, force: true })
        await writeFile(join(staging, "receipt.json"), JSON.stringify({ platform: this.platform, colgrep: "bin/colgrep", ort: `lib/${ortName}`, colgrepVersion: COLGREP_VERSION, ortVersion: ORT_VERSION, model: MODEL, installed: new Date().toISOString() }, null, 2) + "\n")
        await rm(this.runtimeDir, { recursive: true, force: true })
        await rename(staging, this.runtimeDir)
      } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
      // Older runtimes and the download cache are no longer needed.
      for (const entry of await readdir(this.directory)) if (entry.startsWith("runtime-") && entry !== RUNTIME) await rm(join(this.directory, entry), { recursive: true, force: true })
      await rm(cache, { recursive: true, force: true })
      const runtime = await this.runtime()
      if (!runtime) throw new Error("Installed, but the search engine files could not be found afterwards")
      this.#installing = { step: "Checking the search engine (first start can take a minute)", done: items.length, total: items.length + 1 }
      await this.selfTest(runtime)
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /** Runs one tiny search so a broken download or a missing system library shows up now, not on first use. */
  async selfTest(runtime: Runtime): Promise<void> {
    const probe = join(this.directory, "selftest")
    await rm(probe, { recursive: true, force: true })
    await mkdir(probe, { recursive: true, mode: 0o700 })
    await writeFile(join(probe, "a.md"), "Employees may claim a hotel when a flight is cancelled overnight.\n")
    await writeFile(join(probe, "b.md"), "function evictIdleSessions() { /* remove sessions idle for 30 minutes */ }\n")
    try {
      const hits = await colgrep(runtime, probe, "what if my flight is cancelled", 2, undefined, 120_000)
      if (!hits.length || !hits[0]!.file.endsWith("a.md")) throw new Error("The search engine started but returned an unexpected result")
    } finally { await rm(probe, { recursive: true, force: true }) }
  }

  async remove(): Promise<void> {
    for (const entry of await readdir(this.directory).catch(() => [] as string[])) if (entry.startsWith("runtime-") || entry === "downloads") await rm(join(this.directory, entry), { recursive: true, force: true })
  }
}

export interface Hit { readonly file: string; readonly score: number }

/** Runs a semantic search over `directory` (indexing it incrementally first). Indexes live under runtime.home. */
export function colgrep(runtime: Runtime, directory: string, query: string, k: number, signal?: AbortSignal, timeoutMs = 300_000): Promise<Hit[]> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const env: NodeJS.ProcessEnv = {
      HOME: runtime.home, PATH: "/usr/bin:/bin", LANG: process.env.LANG ?? "C.UTF-8",
      XDG_DATA_HOME: join(runtime.home, "data"), XDG_CONFIG_HOME: join(runtime.home, "config"), XDG_CACHE_HOME: join(runtime.home, "cache"),
      ORT_DYLIB_PATH: runtime.ort, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1",
    }
    const child = spawn(runtime.colgrep, ["--json", "--model", runtime.model, "--semantic-only", "-y", "-k", String(k), "--", query], { cwd: directory, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    const out: Buffer[] = []
    let size = 0, stderr = "", done = false
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL") } catch {} }
    const finish = (error?: Error, value?: Hit[]) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      if (error) { kill(); reject(error) } else resolve(value!)
    }
    const abort = () => finish(new Error("Cancelled"))
    const timer = setTimeout(() => finish(new Error(`The search engine took longer than ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (data: Buffer) => { size += data.length; if (size > 64 * 1024 * 1024) finish(new Error("The search engine returned too much output")); else out.push(data) })
    child.stderr.on("data", data => { if (stderr.length < 4000) stderr += data })
    child.on("error", error => finish(new Error(`Could not start the search engine: ${error.message}`)))
    child.on("close", code => {
      if (code !== 0) return finish(new Error(`The search engine failed (exit ${code}): ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`))
      try {
        const parsed = JSON.parse(Buffer.concat(out).toString("utf8") || "[]") as unknown
        const list = Array.isArray(parsed) ? parsed : (parsed as { results?: unknown[] }).results ?? []
        finish(undefined, list.flatMap(item => {
          const hit = item as { unit?: { file?: string; path?: string }; file?: string; score?: number }
          const file = hit.unit?.file ?? hit.unit?.path ?? hit.file
          return typeof file === "string" ? [{ file, score: Number(hit.score ?? 0) }] : []
        }))
      } catch { finish(new Error("The search engine returned output that could not be read")) }
    })
  })
}
