// Project search: an index per project folder, kept in the plugin's data folder (never inside the project).
// Text files are split into overlapping line windows, documents into pages/slides/sheets. Keyword ranking (BM25)
// always works; meaning-based ranking uses the downloaded search engine when present.
import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { basename, extname, join, relative, sep } from "node:path"
import ignore, { type Ignore } from "ignore"
import { colgrep, type Runtime } from "./backend.js"
import { documentKind, extractDocument, MAX_DOCUMENT_BYTES, readBounded } from "./documents.js"

const TEXT = new Set(".md .mdx .txt .rst .adoc .org .tex .py .pyi .ipynb .ts .tsx .js .jsx .mjs .cjs .rs .go .odin .swift .c .h .cc .cpp .hpp .cs .java .kt .kts .scala .rb .php .pl .sh .bash .zsh .fish .ps1 .toml .yaml .yml .json .jsonc .html .htm .css .scss .sql .csv .tsv .xml .ini .cfg .conf .r .jl .lua .ex .exs .erl .zig .nim .dart .proto .graphql .cmake .vue .svelte .tf .hcl .m .mm .f90 .vhd .vhdl .v .sv".split(" "))
const NAMES = new Set(["Dockerfile", "Makefile", "CMakeLists.txt", "README", "LICENSE", "Justfile", "Containerfile"])
const SKIP_DIRS = new Set(["node_modules", "bower_components", "vendor", "dist", "build", "out", "target", "__pycache__", "venv", "site-packages", "coverage"])
const SENSITIVE = /(^|[._-])(secrets?|credentials?|passwords?|private[-_]?key|id_rsa|id_ed25519|id_ecdsa)([._-]|$)/i
const MAX_TEXT_BYTES = 1024 * 1024
export const LIMITS = { files: 5000, bytes: 64 * 1024 * 1024 }

export interface Unit { readonly where: string; readonly text: string }
interface FileEntry { size: number; mtimeMs: number; sha256: string; units: Unit[]; error?: string }
interface Manifest { version: 1; root: string; files: Record<string, FileEntry> }
export interface Inventory { readonly files: string[]; readonly skipped: number; readonly truncated: boolean }
export interface Result { readonly path: string; readonly where: string; readonly excerpt: string; readonly score: number }
export interface SearchOutput {
  readonly mode: "semantic" | "keyword" | "hybrid"
  readonly results: Result[]
  readonly coverage: { files: number; parts: number; truncated: boolean; unreadable: { path: string; reason: string }[] }
  readonly note?: string
}

const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")
export const terms = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** Files worth indexing under `root/scope`, honoring .gitignore files and skipping hidden, generated and secret-looking ones. */
export async function inventory(root: string, scope = ""): Promise<Inventory> {
  const files: string[] = []
  let skipped = 0, bytes = 0, truncated = false
  const walk = async (directory: string, rules: { base: string; ig: Ignore }[]) => {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    try {
      const gitignore = await readFile(join(directory, ".gitignore"), "utf8")
      rules = [...rules, { base: directory, ig: ignore().add(gitignore) }]
    } catch {}
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (truncated) return
      const path = join(directory, entry.name)
      const ignored = (isDir: boolean) => rules.some(rule => { const rel = relative(rule.base, path).split(sep).join("/"); return rel && rule.ig.ignores(isDir ? `${rel}/` : rel) })
      if (entry.name.startsWith(".") || SENSITIVE.test(entry.name)) { skipped++; continue }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || ignored(true)) { skipped++; continue }
        await walk(path, rules)
      } else if (entry.isFile()) {
        const known = TEXT.has(extname(entry.name).toLowerCase()) || NAMES.has(entry.name) || !!documentKind(entry.name)
        if (!known || ignored(false)) { skipped++; continue }
        let size: number
        try { size = (await lstat(path)).size } catch { continue }
        if (size > (documentKind(entry.name) ? MAX_DOCUMENT_BYTES : MAX_TEXT_BYTES)) { skipped++; continue }
        if (files.length >= LIMITS.files || bytes + size > LIMITS.bytes) { truncated = true; return }
        bytes += size
        files.push(relative(root, path).split(sep).join("/"))
      }
    }
  }
  const start = join(root, scope)
  if (relative(root, start).startsWith("..")) throw new Error("scope must be inside the project")
  await walk(start, [])
  return { files, skipped, truncated }
}

/** Overlapping 60-line windows (step 45) with their line numbers. */
export function textUnits(text: string): Unit[] {
  const lines = text.split(/\r?\n/)
  const units: Unit[] = []
  for (let start = 0; start < lines.length; start += 45) {
    const end = Math.min(start + 60, lines.length)
    const content = lines.slice(start, end).join("\n")
    if (content.trim()) units.push({ where: `lines ${start + 1}-${end}`, text: content })
    if (end === lines.length) break
  }
  return units
}

function documentUnits(sections: readonly { label: string; text: string }[]): Unit[] {
  const units: Unit[] = []
  for (const section of sections) {
    if (!section.text.trim() || section.text.startsWith("(no text") || section.text === "(empty)") continue
    for (let offset = 0; offset < section.text.length; offset += 6000) units.push({ where: section.label, text: section.text.slice(offset, offset + 6000) })
  }
  return units
}

/** BM25 over the units. Returns [unit key, score] pairs, best first. */
export function keywordRank(units: readonly { key: string; path: string; text: string }[], query: string, k: number): [string, number][] {
  const wanted = [...new Set(terms(query))]
  if (!wanted.length) return []
  const docs = units.map(unit => { const counts = new Map<string, number>(); for (const term of terms(`${unit.path} ${unit.text}`)) counts.set(term, (counts.get(term) ?? 0) + 1); return counts })
  const lengths = docs.map(doc => [...doc.values()].reduce((a, b) => a + b, 0))
  const average = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length)
  const frequency = new Map(wanted.map(term => [term, docs.filter(doc => doc.has(term)).length]))
  const scores: [string, number][] = []
  docs.forEach((doc, index) => {
    let score = 0
    for (const term of wanted) {
      const count = doc.get(term)
      if (!count) continue
      const df = frequency.get(term)!
      score += Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * lengths[index]! / Math.max(1, average)))
    }
    if (score > 0) scores.push([units[index]!.key, score])
  })
  return scores.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, k)
}

const locks = new Map<string, Promise<unknown>>()
const serially = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
  locks.set(key, next.finally(() => { if (locks.get(key) === next) locks.delete(key) }))
  return next
}

export class ProjectIndex {
  readonly directory: string
  readonly mirror: string
  constructor(indexes: string, readonly root: string) {
    this.directory = join(indexes, hash(root).slice(0, 20))
    this.mirror = join(this.directory, "mirror")
  }

  async #load(): Promise<Manifest> {
    try {
      const manifest = JSON.parse(await readFile(join(this.directory, "manifest.json"), "utf8")) as Manifest
      if (manifest.version === 1 && manifest.root === this.root && manifest.files && typeof manifest.files === "object") return manifest
    } catch {}
    return { version: 1, root: this.root, files: {} }
  }

  /** Brings the index up to date for `scope` (only changed files are read again). */
  refresh(scope = "", signal?: AbortSignal): Promise<{ manifest: Manifest; inventory: Inventory }> {
    return serially(this.directory, async () => {
      await mkdir(this.mirror, { recursive: true, mode: 0o700 })
      const manifest = await this.#load()
      const found = await inventory(this.root, scope)
      const prefix = scope ? `${scope.replace(/\/+$/, "")}/` : ""
      const present = new Set(found.files)
      for (const path of Object.keys(manifest.files)) if ((!prefix || path.startsWith(prefix)) && !present.has(path) && !found.truncated) delete manifest.files[path]
      for (const path of found.files) {
        signal?.throwIfAborted()
        const absolute = join(this.root, path)
        let info
        try { info = await stat(absolute) } catch { delete manifest.files[path]; continue }
        const old = manifest.files[path]
        if (old && old.size === info.size && old.mtimeMs === info.mtimeMs) continue
        try {
          const kind = documentKind(path)
          const data = await readBounded(absolute, kind ? MAX_DOCUMENT_BYTES : MAX_TEXT_BYTES, signal)
          const sha256 = hash(data)
          if (old && old.sha256 === sha256) { old.size = info.size; old.mtimeMs = info.mtimeMs; continue }
          let units: Unit[]
          if (kind) units = documentUnits((await extractDocument(data, kind, signal)).sections)
          else {
            if (data.includes(0)) throw new Error("binary file")
            units = textUnits(new TextDecoder("utf-8", { fatal: false }).decode(data))
          }
          manifest.files[path] = { size: info.size, mtimeMs: info.mtimeMs, sha256, units }
        } catch (error) {
          if (signal?.aborted) throw error
          manifest.files[path] = { size: info.size, mtimeMs: info.mtimeMs, sha256: "", units: [], error: error instanceof Error ? error.message : String(error) }
        }
      }
      await this.#writeMirror(manifest)
      const temporary = join(this.directory, `manifest.json.${process.pid}.tmp`)
      await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 })
      await rename(temporary, join(this.directory, "manifest.json"))
      return { manifest, inventory: found }
    })
  }

  /** One small file per unit, which the search engine indexes. Unchanged files are not rewritten. */
  async #writeMirror(manifest: Manifest): Promise<void> {
    const expected = new Set<string>()
    const existing = new Set(await readdir(this.mirror))
    for (const [path, entry] of Object.entries(manifest.files)) {
      for (const [index, unit] of entry.units.entries()) {
        const name = `${hash(path).slice(0, 16)}-${entry.sha256.slice(0, 8)}-${index}.md`
        expected.add(name)
        if (!existing.has(name)) await writeFile(join(this.mirror, name), `${path} (${unit.where})\n\n${unit.text}\n`, { mode: 0o600 })
      }
    }
    for (const name of existing) if (!expected.has(name)) await unlink(join(this.mirror, name)).catch(() => {})
  }

  async search(query: string, options: { mode?: "auto" | "semantic" | "keyword" | "hybrid"; limit?: number; scope?: string; runtime?: Runtime; signal?: AbortSignal } = {}): Promise<SearchOutput> {
    const limit = options.limit ?? 8
    const scope = (options.scope ?? "").replace(/^\.\/?/, "").replace(/\/+$/, "")
    const { manifest, inventory: found } = await this.refresh(scope, options.signal)
    const prefix = scope ? `${scope}/` : ""
    const units: { key: string; path: string; where: string; text: string }[] = []
    const byMirror = new Map<string, string>()
    const unreadable: { path: string; reason: string }[] = []
    for (const [path, entry] of Object.entries(manifest.files)) {
      if (prefix && !path.startsWith(prefix)) continue
      if (entry.error) unreadable.push({ path, reason: entry.error })
      entry.units.forEach((unit, index) => {
        const key = `${path}#${index}`
        units.push({ key, path, where: unit.where, text: unit.text })
        byMirror.set(`${hash(path).slice(0, 16)}-${entry.sha256.slice(0, 8)}-${index}.md`, key)
      })
    }
    let mode: SearchOutput["mode"] = options.mode === "keyword" ? "keyword" : options.mode === "hybrid" ? "hybrid" : "semantic"
    let note: string | undefined
    if (mode !== "keyword" && !options.runtime) {
      mode = "keyword"
      note = options.mode === "semantic" || options.mode === "hybrid"
        ? "Meaning-based search is not set up on this computer, so keyword ranking was used. The user can download it in Settings → Enhance."
        : "Keyword ranking (meaning-based search is not set up; the user can download it in Settings → Enhance)."
    }
    const pool = Math.max(limit * 10, 50)
    const rankings: [string, number][][] = []
    if (mode !== "semantic") rankings.push(keywordRank(units, query, pool))
    if (mode !== "keyword") {
      try {
        const hits = await colgrep(options.runtime!, this.mirror, query, prefix ? pool * 4 : pool, options.signal)
        rankings.push(hits.flatMap(hit => { const key = byMirror.get(basename(hit.file)); return key ? [[key, hit.score] as [string, number]] : [] }))
      } catch (error) {
        if (options.signal?.aborted) throw error
        note = `Meaning-based search failed (${error instanceof Error ? error.message : String(error)}); keyword ranking was used instead.`
        mode = "keyword"
        rankings.length = 0
        rankings.push(keywordRank(units, query, pool))
      }
    }
    const fused = new Map<string, number>()
    for (const ranking of rankings) ranking.forEach(([key], rank) => fused.set(key, (fused.get(key) ?? 0) + 1 / (60 + rank + 1)))
    const byKey = new Map(units.map(unit => [unit.key, unit]))
    const results: Result[] = []
    const seen = new Set<string>()
    for (const [key, score] of [...fused].sort((a, b) => b[1] - a[1])) {
      const unit = byKey.get(key)
      if (!unit || seen.has(unit.path)) continue
      seen.add(unit.path)
      results.push({ path: unit.path, where: unit.where, excerpt: unit.text.length > 1500 ? `${unit.text.slice(0, 1500)}…` : unit.text, score: Number(score.toFixed(5)) })
      if (results.length >= limit) break
    }
    return { mode, results, coverage: { files: Object.keys(manifest.files).filter(path => !prefix || path.startsWith(prefix)).length, parts: units.length, truncated: found.truncated, unreadable: unreadable.slice(0, 20) }, ...(note && { note }) }
  }
}

/** Total size of all indexes, for the settings page. */
export async function folderSize(path: string): Promise<number> {
  let total = 0
  let entries
  try { entries = await readdir(path, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await folderSize(child)
    else try { total += (await lstat(child)).size } catch {}
  }
  return total
}

export const clearIndexes = (indexes: string) => rm(indexes, { recursive: true, force: true })
