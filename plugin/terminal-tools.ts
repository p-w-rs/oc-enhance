import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { encodeInput, KEYS, RelayBackend, settle, tail, type TerminalBackend, type TerminalInfo } from "./terminal.js"
import { Terminals } from "./terminal-rpc.js"

export interface TerminalOptions {
  /** "allow" (default) types without asking; "ask" shows the native permission prompt for each write. */
  readonly write: "allow" | "ask"
}

export function terminalOptions(raw: unknown): TerminalOptions {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>).terminalWrite : undefined
  if (value !== undefined && value !== "allow" && value !== "ask") throw new Error('open-enhance: terminalWrite must be "allow" or "ask"')
  return { write: (value as "allow" | "ask" | undefined) ?? "allow" }
}

const json = (value: unknown) => ({ content: JSON.stringify(value, null, 2) })
const summary = (info: TerminalInfo, active?: string) => ({
  id: info.id, title: info.title, cwd: info.cwd, status: info.status,
  ...(info.foregroundProcess && { running: info.foregroundProcess }), ...(info.exitCode !== undefined && { exitCode: info.exitCode }),
  size: `${info.size.cols}x${info.size.rows}`, ...(info.id === active && { mostRecent: true }),
})

/** Registers the terminal tools and the GUI registration RPC. Returns their disposers. */
export async function installTerminals(ctx: Plugin.Context, backend?: TerminalBackend): Promise<{ dispose(): Promise<void> }[]> {
  const options = terminalOptions(ctx.options)
  const registrations: { dispose(): Promise<void> }[] = []
  let relay: RelayBackend | undefined
  const rpc = await ctx.rpc.register(Terminals, {
    claim: async input => relay ? relay.claim((input as { id: string }).id) : { ok: false },
    respond: async input => relay ? relay.respond(input as { id: string; ok: boolean; result?: unknown; error?: string }) : { accepted: false },
  })
  registrations.push(rpc)
  if (!backend) {
    relay = new RelayBackend(request => rpc.events.emit("request", request as never))
    registrations.push({ dispose: async () => relay!.dispose() })
  }
  const bridge = backend ?? relay!

  // A session's terminals live on that session or (for subagents) one of its ancestors.
  const lineage = async (sessionID: string) => {
    const result: string[] = []
    let current: string | undefined = sessionID
    while (current && result.length < 16 && !result.includes(current)) {
      result.push(current)
      current = (await ctx.session.get({ sessionID: current as never })).parentID ?? undefined
    }
    return result
  }
  const all = async (context: ToolContext) => {
    const sessions = await lineage(context.sessionID)
    const results = await Promise.allSettled(sessions.map(id => bridge.list(id)))
    // If nothing could be listed at all (e.g. no Desktop window), say why instead of reporting "no terminals".
    if (results.every(result => result.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason
    return { sessions, terminals: results.flatMap(result => result.status === "fulfilled" ? result.value : []) }
  }
  const pick = async (context: ToolContext, id: string | undefined) => {
    const { terminals } = await all(context)
    if (id) {
      const found = terminals.find(item => item.id === id || item.title === id)
      if (!found) throw new Error(`No terminal ${JSON.stringify(id)} in this session. Terminals: ${terminals.map(item => `${item.id} (${item.title})`).join(", ") || "(none; open one with terminal_open or in the Review pane)"}`)
      return found
    }
    const running = terminals.filter(item => item.status === "running")
    if (!running.length) throw new Error("This session has no open terminal. Open one in the Review pane, or with terminal_open.")
    // Most recently written terminal first.
    return running.sort((a, b) => (b.output?.tail ?? 0) - (a.output?.tail ?? 0))[0]!
  }
  const ID = { type: "string", description: "Terminal id or title (default: the session's most recently active terminal)" }

  registrations.push(await ctx.tool.transform(editor => {
    editor.add({
      name: "terminal_list",
      description: "List the shared terminals of this session (the user's terminal tabs in the Review pane, and ones you opened): title, working directory, what is running.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { codemode: false },
      execute: async (_input, context) => {
        const { terminals } = await all(context)
        const active = terminals.filter(item => item.status === "running").sort((a, b) => (b.output?.tail ?? 0) - (a.output?.tail ?? 0))[0]?.id
        return json({ terminals: terminals.map(item => summary(item, active)), ...(!terminals.length && { note: "No terminals yet. The user can open one in the Review pane, or use terminal_open." }) })
      },
    })
    editor.add({
      name: "terminal_read",
      description: "Read what a shared terminal currently shows (the last lines of its screen and scrollback), e.g. to see the output of a command the user ran or the state of an interactive program.",
      input: { type: "object", properties: { id: ID, lines: { type: "integer", minimum: 1, maximum: 2000, description: "How many trailing lines (default 80)" } }, additionalProperties: false },
      options: { codemode: false },
      execute: async (raw: unknown, context) => {
        const input = raw as { id?: string; lines?: number }
        const terminal = await pick(context, input.id)
        const screen = await bridge.snapshot(terminal.id)
        return json({ terminal: summary(screen.info), screen: tail(screen.text, input.lines ?? 80), cursor: screen.cursor })
      },
    })
    editor.add({
      name: "terminal_write",
      description: `Type into a shared terminal, as if the user typed it: text, then optional keys (${Object.keys(KEYS).filter(key => !key.startsWith("ctrl-")).join(", ")}, ctrl-a … ctrl-z such as ctrl-c), then Enter if enter=true. Works with interactive programs (prompts, REPLs, ssh sessions, editors). Returns the screen once output settles (up to wait seconds). The user sees everything typed.`,
      input: {
        type: "object",
        properties: {
          id: ID,
          text: { type: "string", maxLength: 100_000 },
          keys: { type: "array", items: { type: "string" }, maxItems: 50 },
          enter: { type: "boolean", description: "Press Enter after the text and keys (default false)" },
          wait: { type: "number", minimum: 0, maximum: 120, description: "Seconds to wait for output to settle before reading the screen (default 2)" },
          lines: { type: "integer", minimum: 1, maximum: 2000 },
        },
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (raw: unknown, context) => {
        const input = raw as { id?: string; text?: string; keys?: string[]; enter?: boolean; wait?: number; lines?: number }
        const data = encodeInput(input.text, input.keys, input.enter === true)
        if (!data) throw new Error("Nothing to type: give text, keys or enter=true")
        const terminal = await pick(context, input.id)
        if (options.write === "ask") {
          await ctx.permission.assert({
            sessionID: context.sessionID as never, agent: context.agent as never, action: "open_enhance_terminal_write", resources: [terminal.id], save: [terminal.id],
            metadata: { terminal: terminal.title, input: data.length > 300 ? `${data.slice(0, 300)}…` : data },
            source: { type: "tool", messageID: context.messageID, id: context.id },
          })
        }
        await bridge.write(terminal.id, data)
        const screen = await settle(bridge, terminal.id, Math.round((input.wait ?? 2) * 1000))
        return json({ terminal: summary(screen.info), typed: JSON.stringify(data), screen: tail(screen.text, input.lines ?? 80) })
      },
    })
    editor.add({
      name: "terminal_open",
      description: "Open a new shared terminal in this session (it appears in the Review pane, where the user can watch and type too). Optionally run a command instead of the default shell.",
      input: {
        type: "object",
        properties: { title: { type: "string", maxLength: 100 }, cwd: { type: "string" }, command: { type: "string", description: "Program to run (default: the user's shell)" }, args: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (raw: unknown, context) => {
        const input = raw as { title?: string; cwd?: string; command?: string; args?: string[] }
        const info = await bridge.create(context.sessionID, input)
        return json({ opened: summary(info), next: `Use terminal_write id=${info.id} to type into it.` })
      },
    })
  }))
  return registrations
}
