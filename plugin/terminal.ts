/**
 * Shared Review-pane terminals for agents: list, read, type into and open the session's terminals.
 *
 * OpenCode 2.2.6 gives server plugins only `experimental.terminal.read`, and the Desktop adds server credentials outside
 * the page. So the Desktop GUI performs terminal operations with its own (already authenticated) client, relayed from
 * the server plugin: the server emits a request, exactly one window claims and runs it, and posts the result back.
 * Typing briefly takes over the terminal (only the controlling attachment's input is applied), sends the keys and
 * detaches; control returns to the user's tab.
 */

export interface TerminalInfo {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly status: "running" | "exited"
  readonly foregroundProcess: string | null
  readonly sessionID: string
  readonly size: { readonly cols: number; readonly rows: number }
  readonly exitCode?: number
  readonly output?: { readonly head: number; readonly tail: number }
}
export interface Screen { readonly info: TerminalInfo; readonly text: string; readonly cursor: { x: number; y: number } }
export interface CreateInput { title?: string; command?: string; args?: string[]; cwd?: string }

/** What the tools need; implemented by the GUI (ClientBackend) and relayed to the server (RelayBackend). */
export interface TerminalBackend {
  list(sessionID: string): Promise<TerminalInfo[]>
  snapshot(id: string): Promise<Screen>
  create(sessionID: string, input: CreateInput): Promise<TerminalInfo>
  write(id: string, data: string): Promise<void>
}

/** Named keys an agent can send. */
export const KEYS: Readonly<Record<string, string>> = {
  enter: "\r", tab: "\t", escape: "\x1b", backspace: "\x7f", space: " ",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F",
  "page-up": "\x1b[5~", "page-down": "\x1b[6~", delete: "\x1b[3~",
  ...Object.fromEntries("abcdefghijklmnopqrstuvwxyz".split("").map((letter, index) => [`ctrl-${letter}`, String.fromCharCode(index + 1)])),
}

export function encodeInput(text: string | undefined, keys: readonly string[] | undefined, enter: boolean): string {
  let result = text ?? ""
  for (const key of keys ?? []) {
    const value = KEYS[key.toLowerCase()]
    if (value === undefined) throw new Error(`Unknown key ${JSON.stringify(key)}. Keys: ${Object.keys(KEYS).filter(k => !k.startsWith("ctrl-")).join(", ")}, ctrl-a … ctrl-z`)
    result += value
  }
  if (enter) result += "\r"
  return result
}

/** Last `lines` lines of a screen, without trailing blank lines. */
export function tail(text: string, lines: number): string {
  const all = text.replace(/\s+$/, "").split("\n")
  return all.slice(Math.max(0, all.length - lines)).join("\n")
}

function frame(size: { cols: number; rows: number }, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(5 + data.byteLength)
  const view = new DataView(result.buffer)
  result[0] = 1
  view.setUint16(1, size.cols)
  view.setUint16(3, size.rows)
  result.set(data, 5)
  return result
}

/** The subset of the OpenCode client the GUI backend uses. */
export interface PtyApi {
  list(input: { sessionID: string }): Promise<TerminalInfo[]>
  snapshot(input: { ptyID: string }): Promise<{ info: TerminalInfo; text: string; cursor: { x: number; y: number } }>
  create(input: { sessionID: string; title: string; args: string[]; env: Record<string, string>; command?: string; cwd?: string }): Promise<TerminalInfo>
  connectToken(input: { ptyID: string; "x-opencode-ticket"?: string }): Promise<{ ticket: string }>
}

/** Runs terminal operations with an authenticated OpenCode client (the Desktop GUI's, or a test's). */
export class ClientBackend implements TerminalBackend {
  constructor(private readonly api: PtyApi, private readonly baseUrl: string, private readonly Socket: typeof WebSocket = WebSocket) {}

  list(sessionID: string) { return this.api.list({ sessionID }) }
  async snapshot(id: string): Promise<Screen> {
    const snapshot = await this.api.snapshot({ ptyID: id })
    return { info: snapshot.info, text: snapshot.text, cursor: snapshot.cursor }
  }
  create(sessionID: string, input: CreateInput) {
    return this.api.create({ sessionID, title: input.title ?? "Agent terminal", args: input.args ?? [], env: {}, ...(input.command && { command: input.command }), ...(input.cwd && { cwd: input.cwd }) })
  }

  async write(id: string, data: string): Promise<void> {
    const { info } = await this.snapshot(id)
    if (info.status !== "running") throw new Error(`Terminal ${info.title} has exited`)
    const token = await this.api.connectToken({ ptyID: id, "x-opencode-ticket": "1" })
    const base = new URL(this.baseUrl)
    if (!base.pathname.endsWith("/")) base.pathname += "/"
    const url = new URL(`api/experimental/persistent-pty/${encodeURIComponent(id)}/connect`, base)
    url.searchParams.set("ticket", token.ticket)
    url.searchParams.set("cursor", String(info.output?.tail ?? 0)) // no replay of old output
    url.searchParams.set("attachment_id", `open-enhance-agent-${Date.now().toString(36)}`)
    url.searchParams.set("takeover", "true")
    url.searchParams.set("input_protocol", "1")
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = new this.Socket(url)
    socket.binaryType = "arraybuffer"
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The terminal did not accept the connection in time")), 10_000)
        socket.onmessage = event => {
          if (typeof event.data !== "string") return
          try {
            const message = JSON.parse(event.data) as { type?: string; role?: string }
            if (message.type !== "attached") return
            clearTimeout(timer)
            if (message.role && message.role !== "controller") reject(new Error("Could not take control of the terminal"))
            else resolve()
          } catch {}
        }
        socket.onerror = () => { clearTimeout(timer); reject(new Error("Terminal connection failed")) }
        socket.onclose = () => { clearTimeout(timer); reject(new Error("Terminal connection closed")) }
      })
      const bytes = new TextEncoder().encode(data)
      for (let offset = 0; offset < bytes.length; offset += 4096) socket.send(frame(info.size, bytes.subarray(offset, offset + 4096)))
      await new Promise(resolve => setTimeout(resolve, 150))
    } finally {
      socket.onclose = null
      socket.close()
    }
  }
}

/** Waits until the screen stops changing (or the time limit), then returns it. */
export async function settle(backend: Pick<TerminalBackend, "snapshot">, id: string, maxMs: number, quietMs = 400): Promise<Screen> {
  const deadline = Date.now() + maxMs
  let last = await backend.snapshot(id)
  let since = Date.now()
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150))
    const next = await backend.snapshot(id)
    if (next.text !== last.text || next.cursor.x !== last.cursor.x || next.cursor.y !== last.cursor.y) { last = next; since = Date.now() }
    else if (Date.now() - since >= quietMs) break
  }
  return last
}

export type Operation =
  | { op: "list"; sessionID: string }
  | { op: "snapshot"; id: string }
  | { op: "create"; sessionID: string; input: CreateInput }
  | { op: "write"; id: string; data: string }

/** Runs a relayed operation on a backend (GUI side). */
export function perform(backend: TerminalBackend, operation: Operation): Promise<unknown> {
  switch (operation.op) {
    case "list": return backend.list(operation.sessionID)
    case "snapshot": return backend.snapshot(operation.id)
    case "create": return backend.create(operation.sessionID, operation.input)
    case "write": return backend.write(operation.id, operation.data).then(() => ({ written: true }))
  }
}

export const NO_DESKTOP = "Shared terminals are run by the OpenCode Desktop app, and no Desktop window answered. Ask the user to open the app (with open-enhance terminals enabled), then retry."

/** Server side: relays operations to a Desktop window and waits for its answer. */
export class RelayBackend implements TerminalBackend {
  #pending = new Map<string, { claimed: boolean; resolve(value: unknown): void; reject(error: Error): void; claimTimer: ReturnType<typeof setTimeout>; doneTimer: ReturnType<typeof setTimeout> }>()
  #counter = 0
  constructor(private readonly emit: (request: { id: string; operation: Operation }) => Promise<void>, private readonly timeouts = { claimMs: 4000, doneMs: 60_000 }) {}

  #run<T>(operation: Operation): Promise<T> {
    const id = `${Date.now().toString(36)}-${(++this.#counter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise<T>((resolve, reject) => {
      const fail = (error: Error) => { const entry = this.#pending.get(id); if (!entry) return; clearTimeout(entry.claimTimer); clearTimeout(entry.doneTimer); this.#pending.delete(id); reject(error) }
      this.#pending.set(id, {
        claimed: false, resolve: resolve as (value: unknown) => void, reject,
        claimTimer: setTimeout(() => { if (!this.#pending.get(id)?.claimed) fail(new Error(NO_DESKTOP)) }, this.timeouts.claimMs),
        doneTimer: setTimeout(() => fail(new Error("The Desktop app did not finish the terminal operation in time")), this.timeouts.doneMs),
      })
      this.emit({ id, operation }).catch(error => fail(error instanceof Error ? error : new Error(String(error))))
    })
  }

  /** The first window to claim a request runs it; later claims are refused. */
  claim(id: string): { ok: boolean } {
    const entry = this.#pending.get(id)
    if (!entry || entry.claimed) return { ok: false }
    entry.claimed = true
    clearTimeout(entry.claimTimer)
    return { ok: true }
  }

  respond(input: { id: string; ok: boolean; result?: unknown; error?: string }): { accepted: boolean } {
    const entry = this.#pending.get(input.id)
    if (!entry?.claimed) return { accepted: false }
    clearTimeout(entry.doneTimer)
    this.#pending.delete(input.id)
    if (input.ok) entry.resolve(input.result)
    else entry.reject(new Error(input.error || "Terminal operation failed"))
    return { accepted: true }
  }

  list(sessionID: string) { return this.#run<TerminalInfo[]>({ op: "list", sessionID }) }
  snapshot(id: string) { return this.#run<Screen>({ op: "snapshot", id }) }
  create(sessionID: string, input: CreateInput) { return this.#run<TerminalInfo>({ op: "create", sessionID, input }) }
  async write(id: string, data: string) { await this.#run({ op: "write", id, data }) }

  dispose(): void { for (const [id] of this.#pending) this.respond({ id, ok: false, error: "open-enhance is shutting down" }) }
}
