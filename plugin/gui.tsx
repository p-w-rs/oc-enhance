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
  const pickModel = async () => {
    try {
      const { models } = await api().models({}) as unknown as { models: { id: string; name: string; provider: string }[] }
      const choice = await ctx.dialogs.select({
        title: "Fast model for top of mind", placeholder: "Search models",
        current: state()?.settings.topOfMindModel ?? "",
        options: [{ title: "None (rules only)", value: "", description: "Cues from simple rules; no extra model requests" }, ...models.map(model => ({ title: model.name, value: model.id, description: model.id, group: model.provider }))],
      })
      if (choice !== undefined) await act(() => api().update({ topOfMindModel: choice }), choice ? `Top of mind uses ${choice}` : "Top of mind uses rules only")
    } catch (cause) { ctx.toast.show({ title: "Enhance", description: message(cause), variant: "error" }) }
  }
  const toggle = (key: "notes" | "reminders" | "topOfMind" | "documents" | "search" | "terminals") => (value: boolean) => void act(() => api().update({ [key]: value }))
  onMount(() => {
    void refresh()
    // While a download runs, keep the progress current even if the window is in the background.
    const timer = setInterval(() => { if (state()?.search.installing || !state()) void refresh() }, 1500)
    onCleanup(() => clearInterval(timer))
  })
  const feature = (key: "notes" | "reminders" | "topOfMind" | "documents" | "search" | "terminals", title: string, text: string, extra?: () => JSX.Element) => (
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
        {feature("notes", "Task notes, Pause and Resume", "Agents keep short notes (goal, progress, next step) that they see on every turn and are reminded to keep current. Pause above the message box stops the agent, its subagents and the background commands it started, saves a notes checkpoint, and keeps everything stopped until you resume; the agent then continues from its notes. Notes can be handed to a colleague as a file in the project (.opencode/handoffs).")}
        {feature("reminders", "Reminders", "Adds reminder: agents set timers for themselves (\"in 40 min, check the training run\") and are woken with their message when it is due, even after a restart. A paused session gets its reminders when you resume. A pill above the message box shows when the agent will wake up; click it to see or cancel reminders.")}
        {feature("topOfMind", "Top of mind", "In long chats agents forget what they can do. Before each step they get at most three short cues for the capabilities that moment calls for (a tool for Office files, reminders, the reference library, a matching skill …), chosen from the session's own tools and skills by simple rules and, optionally, by a fast model. Cues go at the end of the context, so prompt caching keeps working.", () => (
          <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
            <span style={muted}>Fast model (all sessions): {current().settings.topOfMindModel || "none, rules only"}</span>
            <ctx.ui.Button size="small" variant="ghost" onClick={() => void pickModel()}>Choose…</ctx.ui.Button>
          </div>
        ))}
        {feature("documents", "Read Word, Excel, PowerPoint and PDF", "Adds read_document: agents read .docx, .xlsx, .pptx and .pdf files as text, by page, slide or sheet. Scanned pages without text are not supported (no OCR).")}
        {feature("search", "Project search", "Adds search_project: agents find where something is described or implemented when they don't know the exact words, across code and documents. Indexes are kept in oc-enhance's data folder, never in your projects. Works with keywords out of the box; download the search engine for meaning-based search.", () => (
          <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <Show when={!current().search.supported}><span style={muted}>Meaning-based search is not available for {current().search.platform}; keyword search works.</span></Show>
            <Show when={current().search.supported}>
              <Show when={current().search.installing} fallback={
                <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
                  <span style={muted}>{current().search.installed ? `Meaning-based search: installed (${megabytes(current().search.engineBytes)}).` : "Meaning-based search: not installed (download about 290 MB once: ColGrep by LightOn, ONNX Runtime by Microsoft, LateOn-Code-edge model)."}</span>
                  <Show when={!current().search.installed}><ctx.ui.Button size="small" variant="contrast" icon="download" onClick={() => void act(async () => { const next = await api().installSearch({}); return next })}>Download</ctx.ui.Button></Show>
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
    const until = (due: number) => { const minutes = Math.round((due - Date.now()) / 60000); return minutes <= 0 ? "due now" : minutes < 60 ? `in ${minutes} min` : `in ${(minutes / 60).toFixed(1)} h` }
    // Re-render countdowns every 15 s even when nothing else changes.
    const [tick, setTick] = createSignal(0)
    const ticker = setInterval(() => setTick(value => value + 1), 15_000)
    ctx.signal.addEventListener("abort", () => clearInterval(ticker), { once: true })
    const reminderRows = (session: MountedSession, view: SessionView) => (view.reminders ?? []).slice(0, 6).map(item => ({
      id: `reminder-${item.id}`, icon: "notifications" as const, label: item.message.replace(/\s+/g, " ").slice(0, 110),
      detail: `${until(item.due)}${item.every ? `, every ${item.every} min` : ""} · cancel`,
      run: () => void (async () => {
        try { set(session.key, await session.server.client.rpc(EnhanceRpc).cancelReminder({ sessionID: session.id, id: item.id }, { ...(session.location && { location: session.location }) }) as unknown as SessionView); ctx.toast.show({ title: "Reminder cancelled", variant: "success" }) }
        catch (cause) { ctx.toast.show({ title: "Could not cancel the reminder", description: message(cause), variant: "error" }) }
      })(),
    }))
    const timer = setInterval(() => {
      const session = ctx.sessions.current()
      if (session) void load(session)
    }, 3000)
    ctx.signal.addEventListener("abort", () => clearInterval(timer), { once: true })

    // A reminder is set: the agent's turn has ended, but it will wake up by itself. Shown beside the app's own
    // background-work pill, with a countdown, so nobody prompts the agent thinking it stopped.
    ctx.add(ComposerPill, {
      id: "reminders", order: 49,
      show: input => {
        tick()
        const session = input.session
        const view = views()[session.key]
        if (!view || view === "off" || session.pending || !view.reminders?.length) return undefined
        const next = [...view.reminders].sort((a, b) => a.due - b.due)[0]!
        const due = next.due <= Date.now()
        const label = view.paused && due ? "Reminder waits for Resume" : due ? "Reminder due, waking agent…" : view.reminders.length === 1 ? `Agent wakes ${until(next.due)}` : `${view.reminders.length} reminders · next ${until(next.due)}`
        return {
          label, icon: "notifications", tone: "warning",
          title: `The agent set ${view.reminders.length === 1 ? "a reminder" : `${view.reminders.length} reminders`} and will continue by itself when ${view.reminders.length === 1 ? "it is" : "each is"} due. You don't need to prompt it. Pick one to cancel it.`,
          rows: reminderRows(session, view),
        }
      },
    })
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
            ...(view.pausedAt ? [{ id: "when", label: `Paused ${ago(view.pausedAt)}${view.checkpoint === "saving" ? " · saving notes…" : view.checkpoint === "saved" ? " · notes saved" : view.checkpoint === "failed" ? " · notes not updated" : ""}` }] : []),
            ...[...new Set(view.interrupted ?? [])].slice(0, 4).map((label, index) => ({ id: `stopped-${index}`, label: `Stopped: ${label}`.slice(0, 120) })),
            ...(view.background ?? []).slice(0, 4).map((label, index) => ({ id: `bg-${index}`, label: `Stopped background: ${label}`.slice(0, 120) })),
            ...(view.topOfMind?.cues ?? []).slice(0, 3).map((cue, index) => ({ id: `cue-${index}`, label: `Top of mind: ${cue.name.replace(/^skill:/, "skill ")} (${cue.why})`.slice(0, 120) })),
          ],
        }
        return { label: busy()[session.key] ? "Pausing…" : "Pause", icon: "stop", title: "Pause: stop the agent now and keep it stopped until you resume", run: () => void act(session, "pause") }
      },
    })
    // One shortcut that toggles: ⇧⌘P pauses a running session and resumes a paused one (⇧⌘R is OpenCode's "Toggle review").
    ctx.add(Command, () => {
      const session = ctx.sessions.current()
      const view = session ? views()[session.key] : undefined
      const paused = !!view && view !== "off" && view.paused
      return {
        id: "pause", title: paused ? "Resume paused agent" : "Pause agent", group: "Enhance", bind: "mod+shift+p", enabled: !!session && !session.pending,
        run: () => { const current = ctx.sessions.current(); if (!current) return; const now = views()[current.key]; void act(current, now && now !== "off" && now.paused ? "resume" : "pause") },
      }
    })

    ctx.add(SettingsPage, {
      id: "enhance", title: "Enhance", icon: "sliders",
      entries: [{ id: "enhance", title: "Enhance", description: "Task notes and Pause, documents, project search, shared terminals, reminders", keywords: "oc-enhance pause resume notes handoff documents word excel powerpoint pdf search terminals reminders timers" }],
      render: () => (
        <ctx.ui.SettingsLayout title="Enhance" description="Small additions to OpenCode. Each one can be turned off; OpenCode's own tools are never changed or blocked.">
          <SettingsView ctx={ctx} client={() => ctx.client} />
        </ctx.ui.SettingsLayout>
      ),
    })
  },
})

