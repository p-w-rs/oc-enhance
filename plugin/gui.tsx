import { Command, ComposerPill, Plugin, Slot, type MountedSession } from "@opencode/plugin/gui"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Checkpoints, checkpointView, resumeInput, type CheckpointView, type ResumeInput } from "./rpc.js"

type Action = "pause" | "resume" | "status"
type View = { state: string; busy: boolean }
const unknown: View = { state: "unknown", busy: false }

/** Always resolve the current client of this session's server, including remote servers. */
export async function callCheckpoint(session: MountedSession, action: Action, signal?: AbortSignal, resume?: ResumeInput): Promise<CheckpointView> {
  return checkpointView(await session.server.client.rpc(Checkpoints)[action](
    action === "resume" ? { sessionID: session.id, ...resumeInput(resume!) } : { sessionID: session.id }, { signal, location: session.location },
  ))
}

export default Plugin.define({
  setup(ctx) {
    if (ctx.options.checkpoints !== true) return

    const [views, setViews] = createSignal<Record<string, View>>({})
    const [form, setForm] = createSignal<{ session: MountedSession; revision: number; review: string }>()
    const versions = new Map<string, number>()
    const statusRequests = new Map<string, number>()
    let closeResume: (() => void) | undefined
    const view = (session: MountedSession) => views()[session.key] ?? unknown
    const update = (key: string, next: View) => setViews((previous) => ({ ...previous, [key]: next }))
    const disabled = (session: MountedSession) => view(session).busy || session.pending || !session.server.connected
    const label = (session: MountedSession) => !session.server.connected ? "disconnected" : session.pending ? "session pending" :
      view(session).busy ? "request in progress" : view(session).state === "running" ? "gate open" : view(session).state

    async function run(session: MountedSession, action: Action, resume?: ResumeInput, review = false) {
      if (disabled(session) || ctx.signal.aborted || (action !== "status" && ctx.sessions.current()?.key !== session.key)) return
      const key = session.key
      if (action === "status" && !review && statusRequests.has(key)) return
      const version = (versions.get(key) ?? 0) + 1
      versions.set(key, version)
      // Reading status must not flash the label or disable Pause every two seconds.
      // Mutations supersede pending reads; a late poll cannot overwrite their state.
      if (action === "status" && !review) statusRequests.set(key, version)
      else {
        statusRequests.delete(key)
        update(key, { state: action === "pause" ? "pending" : "unknown", busy: true })
      }
      try {
        const result = await callCheckpoint(session, action, ctx.signal, resume)
        if (!ctx.signal.aborted && versions.get(key) === version) update(key, { state: result.state, busy: false })
        if (action === "resume" && result.continuation === "unconfirmed") ctx.toast.show({ title: "Checkpoint gate opened", description: "Continuation was not confirmed. Check the session before submitting another prompt; do not repeat an uncertain operation.", variant: "error" })
        if (!ctx.signal.aborted && versions.get(key) === version) return result
      } catch {
        if (!ctx.signal.aborted && versions.get(key) === version) {
          update(key, { state: "error", busy: false })
          if (action !== "status") ctx.toast.show({ title: "Checkpoint request failed", description: action === "resume" ? "No success confirmed. The revision may be stale; cancel and reopen Resume to refresh it. Check the server before retrying." : "Status is unknown. Retry or check the session server.", variant: "error" })
        }
      } finally {
        if (statusRequests.get(key) === version) statusRequests.delete(key)
      }
    }

    async function openResume(session: MountedSession) {
      if (disabled(session) || ctx.signal.aborted || ctx.sessions.current()?.key !== session.key) return
      closeResume?.()
      setForm(undefined)
      const result = await run(session, "status", undefined, true)
      if (ctx.signal.aborted || ctx.sessions.current()?.key !== session.key) return
      if (!result || !Number.isSafeInteger(result.revision)) {
        ctx.toast.show({ title: "Cannot open resume", description: "A current checkpoint revision is required. Retry after checking the server.", variant: "error" })
        return
      }
      if (result.state === "degraded") {
        ctx.toast.show({ title: "Checkpoint storage unavailable", description: "Resume was not applied. Repair storage and retry; ordinary native work is not locked by bookkeeping failures.", variant: "error" })
        return
      }
      setForm({ session, revision: result.revision!, review: JSON.stringify({ warnings: result.warnings, workspaceChanged: result.workspaceChanged, notes: result.sessions, operations: result.journal, blockedBy: result.blockedBy }, null, 2) })
      const handle = ctx.dialogs.open((dialog) => <ResumeReview close={dialog.close} />)
      closeResume = handle.close
    }

    async function submitResume() {
      const captured = form()
      if (!captured || ctx.sessions.current()?.key !== captured.session.key) return
      let input: ResumeInput
      try { input = resumeInput(captured) } catch {
        ctx.toast.show({ title: "Current revision required", description: "Reopen Resume to refresh the session state.", variant: "error" })
        return
      }
      const result = await run(captured.session, "resume", input)
      if (result && form() === captured) { closeResume?.(); setForm(undefined) }
    }

    for (const action of ["pause", "resume"] as const) {
      ctx.add(Command, (): Command => {
        const session = ctx.sessions.current()
        return {
          id: action, title: action === "pause" ? "Pause at checkpoint" : "Resume checkpoint",
          section: "session", bind: action === "pause" ? "mod+shift+p" : "mod+shift+r",
          slash: { name: `enhance-${action}` },
          enabled: !!session && !session.pending && session.server.connected && !view(session).busy,
          run: async () => {
            const current = ctx.sessions.current()
            if (current && !disabled(current)) { if (action === "resume") await openResume(current); else await run(current, action) }
          },
        }
      })
    }

    ctx.add(ComposerPill, {
      id: "checkpoint", order: 50,
      show: (input) => ({
        label: `Checkpoint: ${label(input.session)}`,
        title: "Checkpoint gate; not a safe-to-close guarantee",
        tone: !input.session.server.connected || ["error", "degraded"].includes(view(input.session).state) ? "danger" : undefined,
        rows: [
          { id: "status", label: `Status: ${label(input.session)}`, detail: "Pause covers this session tree's agent tools, not manual shells or unrelated sessions" },
          ...(disabled(input.session) ? [] : [
            { id: "pause", label: "Pause at checkpoint", run: () => { void run(input.session, "pause") } },
            { id: "resume", label: "Review and resume…", run: () => { void openResume(input.session) } },
            { id: "refresh", label: "Refresh status", run: () => { void run(input.session, "status") } },
          ]),
        ],
      }),
    })

    for (const action of ["pause", "resume"] as const) {
      ctx.add(ComposerPill, {
        id: `checkpoint-${action}`, order: action === "pause" ? 51 : 52,
        show: (input) => ({
          label: action === "pause" ? "Pause" : "Resume…",
          title: action === "pause" ? "Pause at checkpoint; not a safe-to-close guarantee" : "Review checkpoint before resuming",
          // No menu: these are direct controls. Resume still always opens review.
          run: disabled(input.session) ? undefined : () => {
            if (action === "pause") void run(input.session, "pause")
            else void openResume(input.session)
          },
        }),
      })
    }

    function Controls(props: { session: MountedSession; active: boolean }) {
      createEffect(() => {
        const session = props.session
        const client = session.server.client // Re-fetch after server restart/re-authentication.
        const connected = session.server.connected
        const active = props.active
        void client
        if (!active || session.pending) return
        if (!connected) {
          versions.set(session.key, (versions.get(session.key) ?? 0) + 1)
          statusRequests.delete(session.key)
          update(session.key, unknown)
          return
        }
        // Untracked scheduling avoids re-running this effect on our own status writes.
        // Do not disable/refocus review inputs on each background poll. Resume
        // still validates the captured revision against fresh durable state.
        const refresh = () => { if (form()?.session.key !== session.key) void run(session, "status") }
        const initial = setTimeout(refresh, 0)
        const timer = setInterval(refresh, 2000)
        onCleanup(() => { clearTimeout(initial); clearInterval(timer) })
      })
      const unavailable = () => disabled(props.session)
      return <div style={{ display: "inline-flex", gap: "6px", "align-items": "center", "flex-wrap": "wrap" }}>
        <span role="status" aria-live="polite" title="Checkpoint status only; not a safe-to-close guarantee.">
          Checkpoint: {label(props.session)}
        </span>
        <details>
          <summary>Checkpoint actions</summary>
          <ctx.ui.Button size="small" disabled={unavailable()} onClick={() => void run(props.session, "pause")}>Pause</ctx.ui.Button>
          <ctx.ui.Button size="small" disabled={unavailable()} onClick={() => void openResume(props.session)}>Review and resume</ctx.ui.Button>
        </details>
      </div>
    }

    function ResumeReview(props: { close: () => void }) {
      const captured = form()
      createEffect(() => { if (ctx.sessions.current()?.key !== captured?.session.key) props.close() })
      onCleanup(() => { if (form()?.session.key === captured?.session.key) setForm(undefined) })
      const unavailable = () => !captured || disabled(captured.session) || ctx.sessions.current()?.key !== captured.session.key
      return <ctx.ui.Dialog title="Review checkpoint before resuming">
        <Show when={form()}>{(current) =>
          <form style={{ display: "flex", "flex-direction": "column", gap: "12px", padding: "16px", "max-height": "70vh", "overflow": "auto" }} aria-label="Explicit checkpoint resume" onSubmit={(event) => { event.preventDefault(); void submitResume() }}>
            <span>Resume this session at revision {current().revision}. Interrupted operations may have uncertain outcomes; they will not be automatically replayed. Independently paused children remain paused.</span>
            <details><summary>Task checkpoint and observed operations</summary><pre style={{ "max-height": "240px", "overflow": "auto", "white-space": "pre-wrap" }}>{current().review}</pre></details>
            <ctx.ui.Button type="submit" variant="contrast" disabled={unavailable()}>Resume</ctx.ui.Button>
            <ctx.ui.Button type="button" disabled={unavailable()} onClick={props.close}>Cancel</ctx.ui.Button>
          </form>
        }</Show>
      </ctx.ui.Dialog>
    }

    ctx.add(Slot, {
      at: "session.header", order: 50,
      render: (input) => <Controls session={input.session} active={input.active} />,
    })
  },
})
