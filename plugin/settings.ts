import { readFileSync, statSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const PLUGIN_ID = "oc-enhance"
export const VERSION = "1.4.1"

/** `$XDG_DATA_HOME/oc-enhance` unless configured. */
export const dataDirectory = (configured?: string) => configured ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), PLUGIN_ID)

export interface Settings {
  /** Task notes, Pause/Resume and handoffs. */
  readonly notes: boolean
  /** The reminder tool: agents set timers that wake the session later. */
  readonly reminders: boolean
  /** Short cues for the capabilities the current moment calls for (rules, plus the fast model if one is set). */
  readonly topOfMind: boolean
  /** "provider/model" of a fast model that helps choose the cues, shared by every session; "" for rules only. */
  readonly topOfMindModel: string
  /** read_document for Word, Excel, PowerPoint and PDF. */
  readonly documents: boolean
  /** search_project. */
  readonly search: boolean
  /** Shared Review-pane terminals (needs OpenCode Desktop). */
  readonly terminals: boolean
  /** "allow": agents type into terminals without asking; "ask": the native prompt for each write. */
  readonly terminalWrite: "allow" | "ask"
}

export const DEFAULTS: Settings = { notes: true, reminders: true, topOfMind: true, topOfMindModel: "", documents: true, search: true, terminals: true, terminalWrite: "allow" }
const BOOLEANS = ["notes", "reminders", "topOfMind", "documents", "search", "terminals"] as const

export function normalizeSettings(raw: unknown, base: Settings = DEFAULTS): Settings {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const result: Record<string, unknown> = { ...base }
  for (const key of BOOLEANS) if (typeof value[key] === "boolean") result[key] = value[key]
  if (value.terminalWrite === "allow" || value.terminalWrite === "ask") result.terminalWrite = value.terminalWrite
  if (typeof value.topOfMindModel === "string" && (value.topOfMindModel === "" || /^[^/\s]+\/\S+$/.test(value.topOfMindModel.trim()))) result.topOfMindModel = value.topOfMindModel.trim()
  return result as unknown as Settings
}

/** Settings in `<data>/settings.json`, shared by every OpenCode server and location on this computer. */
export class SettingsStore {
  #value: Settings = DEFAULTS
  #mtime = -1
  private constructor(readonly path: string) {}

  static async open(directory: string): Promise<SettingsStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const store = new SettingsStore(join(directory, "settings.json"))
    store.current()
    return store
  }

  /** Current settings; re-read when the file changed (cheap: one stat). */
  current(): Settings {
    let mtime = 0
    try { mtime = statSync(this.path).mtimeMs } catch {}
    if (mtime !== this.#mtime) {
      this.#mtime = mtime
      try { this.#value = mtime ? normalizeSettings(JSON.parse(readFileSync(this.path, "utf8"))) : DEFAULTS } catch { this.#value = DEFAULTS }
    }
    return this.#value
  }

  async update(patch: unknown): Promise<Settings> {
    const next = normalizeSettings(patch, this.current())
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
    await rename(temporary, this.path)
    return this.current()
  }

  /** Calls `listener` when settings change (here or in another process). Returns a stop function. */
  watch(listener: (settings: Settings) => void, intervalMs = 3000): () => void {
    let last = JSON.stringify(this.current())
    const timer = setInterval(() => {
      const now = JSON.stringify(this.current())
      if (now !== last) { last = now; listener(this.current()) }
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}

