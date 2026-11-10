import { Command, ComposerPill, Plugin, SettingsPage, type Context, type MountedSession } from "@opencode/plugin/gui"
import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { EnhanceRpc, type SessionView, type StateView } from "./rpc.js"
import { Terminals } from "./terminal-rpc.js"
import { ClientBackend, perform, type Operation, type PtyApi } from "./terminal.js"

type Client = MountedSession["server"]["client"]
const muted: JSX.CSSProperties = { opacity: 0.7, "font-size": "12px" }
const card: JSX.CSSProperties = { border: "1px solid color-mix(in srgb, currentColor 14%, transparent)", "border-radius": "8px", padding: "12px", display: "flex", "flex-direction": "column", gap: "8px" }
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^.*?Error: /, "")
const megabytes = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / 1e6))} MB`
const ago = (at: number) => { const minutes = Math.round((Date.now() - at) / 60000); return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago` }

/** Runs the agent's terminal requests relayed from each connected server, with this window's client. */
function relayTerminals(ctx: Context) {
  const listening = new Map<string, () => void>()
  const watch = () => {
    for (const id of ctx.servers.list()) {
      const server = ctx.servers.get(id)
      if (!server?.connected || !server.compatible) { listening.get(id)?.(); listening.delete(id); continue }
      if (listening.has(id)) continue
      const rpc = server.client.rpc(Terminals)
      const backend = new ClientBackend(server.client.experimental.persistentPty as unknown as PtyApi, server.url)
      listening.set(id, rpc.events.on("request", async event => {
        const { id: request, operation } = event.data as { id: string; operation: Operation }
        const where = (event as { location?: unknown }).location
        const options = where ? { location: where as never } : undefined
        try { if (!(await rpc.claim({ id: request }, options) as { ok: boolean }).ok) return } catch { return }
        try { await rpc.respond({ id: request, ok: true, result: await perform(backend, operation) as never }, options) }
        catch (error) { await rpc.respond({ id: request, ok: false, error: message(error) }, options).catch(() => {}) }
      }, { signal: ctx.signal }))
    }
  }
  watch()
  const timer = setInterval(watch, 5000)
  ctx.signal.addEventListener("abort", () => { clearInterval(timer); for (const stop of listening.values()) stop() }, { once: true })
}

function SettingsView(props: { ctx: Context; client: () => Client }) {
  const { ctx } = props
  const [state, setState] = createSignal<StateView>()
  const [error, setError] = createSignal<string>()
  const api = () => props.client().rpc(EnhanceRpc)
  const refresh = async () => { try { setState(await api().state({}) as unknown as StateView); setError(undefined) } catch (cause) { setError(message(cause)) } }
  const act = async (action: () => Promise<unknown>, success?: string) => {
    try { const next = await action() as StateView; if (next?.settings) setState(next); if (success) ctx.toast.show({ title: success, variant: "success" }) }
    catch (cause) { ctx.toast.show({ title: "Enhance", description: message(cause), variant: "error" }) }
    finally { await refresh() }
  }
  const toggle = (key: "notes" | "documents" | "search" | "terminals" | "pixi") => (value: boolean) => void act(() => api().update({ [key]: value }))
  onMount(() => {
    void refresh()
    const timer = setInterval(() => { if (document.visibilityState === "visible" && (state()?.search.installing || !state())) void refresh() }, 1500)
    onCleanup(() => clearInterval(timer))
  })
  const feature = (key: "notes" | "documents" | "search" | "terminals" | "pixi", title: string, text: string, extra?: () => JSX.Element) => (
    <div style={card}>
      <ctx.ui.Switch label={title} checked={state()!.settings[key]} onChange={toggle(key)} />
      <span style={muted}>{text}</span>
      <Show when={state()!.settings[key] && extra}>{extra!()}</Show>
    </div>
  )
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "font-size": "13px" }}>
      <Show when={error() && !state()}><div style={{ color: "#e03131" }}>oc-enhance is not answering: {error()}. Is it installed on this server?</div></Show>
      <Show when={!state() && !error()}><ctx.ui.Loader /></Show>
      <Show when={state()}>{current => <>
        {feature("notes", "Task notes, Pause and Resume", "Agents keep short notes (goal, progress, next step) that they see on every turn. Pause above the message box stops the agent and keeps it stopped until you resume; the agent then continues from its notes. Notes can be handed to a colleague as a file in the project (.opencode/handoffs).")}
        {feature("documents", "Read Word, Excel, PowerPoint and PDF", "Adds read_document: agents read .docx, .xlsx, .pptx and .pdf files as text, by page, slide or sheet. Scanned pages without text are not supported (no OCR).")}
        {feature("search", "Project search", "Adds search_project: agents find where something is described or implemented when they don't know the exact words, across code and documents. Indexes are kept in oc-enhance's data folder, never in your projects. Works with keywords out of the box; download the search engine for meaning-based search.", () => (
          <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <Show when={!current().search.supported}><span style={muted}>Meaning-based search is not available for {current().search.platform}; keyword search works.</span></Show>
            <Show when={current().search.supported}>
              <Show when={current().search.installing} fallback={
                <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
                  <span style={muted}>{current().search.installed ? `Meaning-based search: installed (${megabytes(current().search.engineBytes)}).` : "Meaning-based search: not installed (download about 290 MB once: ColGrep by LightOn, ONNX Runtime by Microsoft, LateOn-Code-edge model)."}</span>
                  <Show when={!current().search.installed}><ctx.ui.Button size="small" variant="contrast" icon="download" onClick={() => void act(() => api().installSearch({}))}>Download</ctx.ui.Button></Show>
                  <Show when={current().search.installed}><ctx.ui.Button size="small" variant="ghost" onClick={() => void act(() => api().removeSearch({}), "Search engine removed")}>Remove</ctx.ui.Button></Show>
                </div>
              }>{installing => <span style={muted}>{installing().step} ({installing().done + 1}/{installing().total})…</span>}</Show>
              <Show when={current().search.error}><span style={{ color: "#e03131", "font-size": "12px" }}>Download failed: {current().search.error}</span></Show>
            </Show>
            <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
              <span style={muted}>Indexes: {megabytes(current().search.indexBytes)}</span>
              <ctx.ui.Button size="small" variant="ghost" onClick={() => void act(() => api().clearIndexes({}), "Indexes cleared; they are rebuilt on the next search")}>Clear indexes</ctx.ui.Button>
            </div>
          </div>
        ))}
        {feature("terminals", "Shared terminals", "Agents can list, read, type into and open terminals in the Review pane (needs OpenCode Desktop to be open). You see everything they type.", () => (
          <ctx.ui.Switch label="Ask before an agent types into a terminal" checked={current().settings.terminalWrite === "ask"} onChange={value => void act(() => api().update({ terminalWrite: value ? "ask" : "allow" }))} />
        ))}
        {feature("pixi", "Pixi know-how", "Agents are reminded to use Pixi for Python (scripts and projects) and to prefer Pixi-managed toolchains, and get a pixi skill with the details. Nothing is blocked.")}
        <span style={muted}>oc-enhance {current().version} · data in {current().dataDirectory} · settings apply to every session on this computer.</span>
      </>}</Show>
    </div>
  )
}

export default Plugin.define({
  setup(ctx) {
    relayTerminals(ctx)

    // ---- Pause / Resume above the message box ----
    const [views, setViews] = createSignal<Record<string, SessionView | "off">>({})
    const [busy, setBusy] = createSignal<Record<string, boolean>>({})
    const set = (key: string, value: SessionView | "off") => setViews(previous => JSON.stringify(previous[key]) === JSON.stringify(value) ? previous : { ...previous, [key]: value })
    const inFlight = new Set<string>()
    const load = async (session: MountedSession) => {
      if (session.pending || !session.server.connected || inFlight.has(session.key)) return
      inFlight.add(session.key)
      try { set(session.key, await session.server.client.rpc(EnhanceRpc).session({ sessionID: session.id }, { ...(session.location && { location: session.location }) }) as unknown as SessionView) }
      catch { set(session.key, "off") }
      finally { inFlight.delete(session.key) }
    }
    const act = async (session: MountedSession, action: "pause" | "resume") => {
      if (busy()[session.key]) return
      setBusy(previous => ({ ...previous, [session.key]: true }))
      try {
        const view = await session.server.client.rpc(EnhanceRpc)[action]({ sessionID: session.id }, { ...(session.location && { location: session.location }) }) as unknown as SessionView
        set(session.key, view)
        if (action === "pause") ctx.toast.show({ title: "Paused", description: "The agent stopped and stays stopped until you resume or send a message.", variant: "success" })
      } catch (cause) { ctx.toast.show({ title: action === "pause" ? "Could not pause" : "Could not resume", description: message(cause), variant: "error" }) }
      finally { setBusy(previous => ({ ...previous, [session.key]: false })) }
    }
    const timer = setInterval(() => {
      const session = ctx.sessions.current()
      if (session && document.visibilityState === "visible") void load(session)
    }, 3000)
    ctx.signal.addEventListener("abort", () => clearInterval(timer), { once: true })

    ctx.add(ComposerPill, {
      id: "pause", order: 50,
      show: input => {
        const session = input.session
        const view = views()[session.key]
        if (view === undefined) { queueMicrotask(() => void load(session)); return undefined }
        if (view === "off" || session.pending) return undefined
        if (view.paused) return {
          label: "Paused · Resume", icon: "status", tone: "warning", title: "Paused. Resume continues from the task notes.",
          rows: [
            { id: "resume", label: "Resume (agent continues)", icon: "enter", run: () => void act(session, "resume") },
            ...(view.notes ? [{ id: "next", label: `Next: ${view.notes.next || view.notes.goal}`.slice(0, 120) }] : []),
            ...(view.pausedAt ? [{ id: "when", label: `Paused ${ago(view.pausedAt)}${view.interrupted?.length ? `; stopped: ${[...new Set(view.interrupted)].join(", ")}` : ""}`.slice(0, 160) }] : []),
          ],
        }
        return { label: busy()[session.key] ? "Pausing…" : "Pause", icon: "stop", title: "Pause: stop the agent now and keep it stopped until you resume", run: () => void act(session, "pause") }
      },
    })
    ctx.add(Command, () => {
      const session = ctx.sessions.current()
      return { id: "pause", title: "Pause agent", group: "Enhance", bind: "mod+shift+p", enabled: !!session && !session.pending, run: () => { const current = ctx.sessions.current(); if (current) void act(current, "pause") } }
    })
    ctx.add(Command, () => {
      const session = ctx.sessions.current()
      return { id: "resume", title: "Resume paused agent", group: "Enhance", bind: "mod+shift+r", enabled: !!session && !session.pending, run: () => { const current = ctx.sessions.current(); if (current) void act(current, "resume") } }
    })

    ctx.add(SettingsPage, {
      id: "enhance", title: "Enhance", icon: "sliders",
      entries: [{ id: "enhance", title: "Enhance", description: "Task notes and Pause, documents, project search, shared terminals, Pixi", keywords: "oc-enhance pause resume notes handoff documents word excel powerpoint pdf search terminals pixi" }],
      render: () => (
        <ctx.ui.SettingsLayout title="Enhance" description="Small additions to OpenCode. Each one can be turned off; OpenCode's own tools are never changed or blocked.">
          <SettingsView ctx={ctx} client={() => ctx.client} />
        </ctx.ui.SettingsLayout>
      ),
    })
  },
})

