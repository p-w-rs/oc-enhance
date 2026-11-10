import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { ClientBackend, encodeInput, NO_DESKTOP, perform, RelayBackend, settle, tail, type PtyApi } from "./terminal.js"
import { installTerminals } from "./terminal-tools.js"

const binary = fileURLToPath(new URL(`../.local/host/node_modules/@opencode/cli-${process.platform}-${process.arch}/bin/opencode`, import.meta.url))
const PASSWORD = "terminal-test-password"
let home: string, server: ChildProcess, url: string, sessionID: string
const auth = { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` }
const api = async (method: string, route: string, body?: unknown) => {
  const response = await fetch(url + route, { method, headers: { ...auth, "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) })
  return (await response.json() as { data: any }).data
}

before(async () => {
  // The real OpenCode server (pinned), installed into .local/host on first use.
  const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../scripts/smoke-host.mjs", import.meta.url)), "--install-cli"], { stdio: "inherit" })
  if (result.status !== 0) throw new Error("Could not install the OpenCode CLI for the terminal tests")
  home = await mkdtemp(path.join(tmpdir(), "oe-term-"))
  await mkdir(path.join(home, "ws"))
  const port = 41000 + Math.floor(Math.random() * 15000)
  url = `http://127.0.0.1:${port}`
  server = spawn(binary, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: path.join(home, "ws"), detached: true, stdio: "ignore",
    env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin", SHELL: "/bin/sh", XDG_CONFIG_HOME: path.join(home, "c"), XDG_DATA_HOME: path.join(home, "d"), XDG_CACHE_HOME: path.join(home, "k"), XDG_STATE_HOME: path.join(home, "s"), OPENCODE_SERVER_PASSWORD: PASSWORD },
  })
  for (let i = 0; i < 120; i++) { try { await fetch(`${url}/api/health`); break } catch { await new Promise(r => setTimeout(r, 250)) } }
  sessionID = (await api("POST", `/api/session?location=${encodeURIComponent(JSON.stringify({ directory: path.join(home, "ws") }))}`, {})).id
})
after(async () => {
  try { process.kill(-server.pid!, "SIGTERM") } catch {}
  await new Promise(r => setTimeout(r, 300))
  await rm(home, { recursive: true, force: true })
})

/** An authenticated client like the Desktop GUI's. */
const ptyApi: PtyApi = {
  list: ({ sessionID }) => api("GET", `/api/experimental/session/${sessionID}/terminal`),
  snapshot: ({ ptyID }) => api("GET", `/api/experimental/persistent-pty/${ptyID}/snapshot`),
  create: ({ sessionID, ...body }) => api("POST", `/api/experimental/session/${sessionID}/terminal`, body),
  connectToken: async ({ ptyID }) => (await fetch(`${url}/api/experimental/persistent-pty/${ptyID}/connect-token`, { method: "POST", headers: { ...auth, "x-opencode-ticket": "1" } }).then(r => r.json()) as { data: { ticket: string } }).data,
}
const guiBackend = () => new ClientBackend(ptyApi, url)

/** The user's Review-pane tab: the first, controlling attachment. */
async function userTab(ptyID: string) {
  const token = await fetch(`${url}/api/experimental/persistent-pty/${ptyID}/connect-token`, { method: "POST", headers: { ...auth, "x-opencode-ticket": "1" } }).then(r => r.json()) as { data: { ticket: string } }
  const target = new URL(`${url}/api/experimental/persistent-pty/${ptyID}/connect`)
  target.searchParams.set("ticket", token.data.ticket); target.searchParams.set("cursor", "0"); target.searchParams.set("attachment_id", "user-tab"); target.searchParams.set("takeover", "false"); target.searchParams.set("input_protocol", "1")
  target.protocol = "ws:"
  const socket = new WebSocket(target)
  socket.binaryType = "arraybuffer"
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  await new Promise(r => setTimeout(r, 300))
  const type = (text: string) => {
    const data = new TextEncoder().encode(text), frame = new Uint8Array(5 + data.length), view = new DataView(frame.buffer)
    frame[0] = 1; view.setUint16(1, 80); view.setUint16(3, 24); frame.set(data, 5); socket.send(frame)
  }
  return { socket, type }
}

test("input encoding and screen tails", () => {
  assert.equal(encodeInput("ls", ["enter"], false), "ls\r")
  assert.equal(encodeInput(undefined, ["ctrl-c", "up"], true), "\x03\x1b[A\r")
  assert.throws(() => encodeInput("x", ["hyperdrive"], false), /Unknown key/)
  assert.equal(tail("a\nb\nc\n\n\n", 2), "b\nc")
})

test("the relay: one window claims and runs each request; no window means a clear error", async () => {
  const gui = guiBackend()
  const requests: { id: string; operation: any }[] = []
  const relay = new RelayBackend(async request => { requests.push(request) }, { claimMs: 300, doneMs: 5000 })
  const pending = relay.list(sessionID)
  await new Promise(r => setTimeout(r, 20))
  const [request] = requests
  assert.deepEqual(relay.claim(request!.id), { ok: true })
  assert.deepEqual(relay.claim(request!.id), { ok: false }, "a second window is refused")
  relay.respond({ id: request!.id, ok: true, result: await perform(gui, request!.operation) })
  assert.ok(Array.isArray(await pending))
  await assert.rejects(relay.snapshot("pty_x"), new RegExp(NO_DESKTOP.slice(0, 30)))
  const failing = relay.snapshot("pty_y")
  await new Promise(r => setTimeout(r, 20))
  relay.claim(requests.at(-1)!.id)
  relay.respond({ id: requests.at(-1)!.id, ok: false, error: "boom" })
  await assert.rejects(failing, /boom/)
})

test("agent types into the user's terminal and the user keeps control afterwards", async () => {
  const bridge = guiBackend()
  const terminal = await bridge.create(sessionID, { title: "user shell", command: "/bin/sh" })
  const tab = await userTab(terminal.id)
  tab.type("echo USER_BEFORE_$((1+1))\r")
  await bridge.write(terminal.id, encodeInput("echo AGENT_$((20+1))", [], true))
  const screen = await settle(bridge, terminal.id, 3000)
  assert.match(screen.text, /USER_BEFORE_2/)
  assert.match(screen.text, /AGENT_21/, "agent input applied")
  tab.type("echo USER_AFTER_$((3+3))\r")
  await new Promise(r => setTimeout(r, 1200))
  assert.match((await bridge.snapshot(terminal.id)).text, /USER_AFTER_6/, "the user's tab still controls the terminal")
  tab.socket.close()
})

test("tools: list, read, write to the session's terminals, open a new one", async () => {
  const bridge = guiBackend()
  const tools = new Map<string, any>()
  const asked: unknown[] = []
  const ctx = {
    options: { terminals: true },
    rpc: { register: async () => ({ dispose: async () => {}, events: { emit: async () => {} } }) },
    session: { get: async () => ({ parentID: undefined }) },
    permission: { assert: async (input: unknown) => { asked.push(input) } },
    tool: { transform: async (callback: (editor: unknown) => void) => { callback({ add: (tool: { name: string }) => tools.set(tool.name, tool) }); return { dispose: async () => {} } } },
  }
  let enabled = true
  await installTerminals(ctx as unknown as Plugin.Context, { enabled: () => enabled, write: () => "allow" }, bridge)
  assert.deepEqual([...tools.keys()].sort(), ["terminal_list", "terminal_open", "terminal_read", "terminal_write"])
  const context = { sessionID, agent: "build", messageID: "m", id: "c", signal: new AbortController().signal }
  const run = async (name: string, input: unknown) => JSON.parse((await tools.get(name).execute(input, context)).content)
  const opened = await run("terminal_open", { title: "agent shell", command: "/bin/sh" })
  const list = await run("terminal_list", {})
  assert.ok(list.terminals.some((item: { id: string }) => item.id === opened.opened.id))
  const written = await run("terminal_write", { id: "agent shell", text: "printf 'TOOL_%s\\n' ok", enter: true, wait: 3 })
  assert.match(written.screen, /TOOL_ok/)
  const read = await run("terminal_read", { id: opened.opened.id, lines: 5 })
  assert.match(read.screen, /TOOL_ok/)
  assert.deepEqual(asked, [], "writing is allowed by default")
  await assert.rejects(run("terminal_read", { id: "nope" }), /No terminal "nope"/)
  void enabled
})
