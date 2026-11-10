# Desktop checkpoint controls

Targets OpenCode **2.2.6**. Checkpoints are disabled by default. Enable them in the plugin entry's options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/absolute/path/to/open-enhance", "options": { "checkpoints": true } }]
}
```

This example is configuration guidance only; setup does not edit user configuration.

The primary desktop controls are official **ComposerPill** contributions in the row immediately above the composer, beside native background-work and todo pills: stable **Checkpoint: …** status, a direct **Pause** button and a direct **Resume…** button. Clicking Pause requests the pause; clicking Resume opens review, never an unconditional play toggle. Clicking the status pill still opens an actions/status menu. OpenCode 2.2.6 does **not** expose a supported slot inside or beside native Send/Stop. Native Stop and permissions remain unchanged; there are no DOM mutations, internal selectors, or native-button replacements.

The official `session.header` slot (the timeline title row) retains status and a collapsed **Checkpoint actions** fallback, rather than duplicate primary buttons. This fallback also works for subagent sessions, where the host does not show composer pills. Resume review opens in the host's native dialog, not inside the height-constrained header.

- **Pause** requests a server checkpoint; pending is not paused.
- **Resume** fetches the current revision, then opens a native confirmation dialog showing notes and uncertainty notices. There is no mandatory prose field or acknowledgment switch. Resume submits only the captured revision to the selected session/server; Cancel changes nothing. Stale revisions require a fresh dialog. Independent child pauses remain paused, and operations are never automatically replayed. Degraded storage cannot claim successful durable Resume.
- The header fetches status when mounted/activated, after reconnects, and every two seconds while active, except during explicit review so background polling cannot disrupt input focus. Resume still validates the captured revision against fresh durable state. Errors and unavailable servers never count as paused. Restart recovery comes from server status, not persisted GUI flags.
- Background status reads retain the displayed status and available controls; they do not flash **request in progress** every two seconds. Overlapping background reads are coalesced. Pause can supersede a slow poll, and a late poll cannot overwrite a newer mutation. Resume review requests a fresh revision independently of a pending background poll.
- During an actual Pause/Resume/review request, session creation, or disconnect, direct controls are unavailable and the pill menu shows status only; action callbacks also recheck availability. Errors are labeled explicitly and allow a status refresh when connected. **Gate open** corresponds to the server's `running` checkpoint state: it means the checkpoint gate is open, not that the native agent is busy or that any work is currently running.
- Commands **Pause at checkpoint** and **Resume checkpoint** appear in the palette and Settings > Shortcuts. Defaults are `mod+shift+p` and `mod+shift+r` (customizable); slash entries are `/enhance-pause` and `/enhance-resume`.
- Actions and status target the selected session's server, including remote sessions. That server must also run the checkpoint-enabled server plugin; otherwise the control reports an error.

No displayed state is a general **safe-to-close** guarantee. Checkpoints do not establish that background processes, external effects, or unrelated sessions have stopped.

There is no shell-creation hook or cross-session barrier. Unknown outcomes warn
without locking native work; bookkeeping failures are shown as degraded state. See
[checkpoint safety limits](checkpoints.md#unattributed-native-shells).

## Live acceptance on the development Mac

**Historical evidence:** these checks exercised the previous barrier/reconciliation
implementation. They do not validate the revised nonblocking behavior or current
revision-only dialog; current source has SDK, CLI and GUI unit/build validation.

An isolated OpenCode 2.2.6 Desktop profile exercised actual composer-pill
rendering, paused state, a native reconciliation dialog, explicit review/Resume,
native Stop on a streaming response, checkpoint interruption of streaming,
a native permission request with Deny, service restart/reconnection, and closing
and reopening the same desktop profile. The paused gate and revision survived
both service and desktop restart, including a newly created descendant.
Local scripted SSE responses were used, not a real LLM. A live-discovered header
clipping bug was fixed by using the native dialog; the then-added broad shell
barrier has since been removed. Raw DOM/screenshots/logs stay under
`.local/`. This is not a physical sleep/wake or independent-machine test.

Additional live checks passed for stale Resume after a workspace move, switching
sessions during review, Pause in flight while switching sessions, and a service
crash during review fetch. A native foreground General subagent and its parent
were both active before GUI Pause interrupted both; the child stream was
cancelled and its durable ancestor gate remained closed.

## Virtual-machine lifecycle acceptance

A disposable Apple Silicon UTM guest running macOS 26.6.2 exercised the actual
Desktop/service. Hypervisor suspension prevented guest execution; resumption
returned to the same boot with the same paused revision and descendant gate.
A forbidden shell side effect remained blocked. Explicit native Resume restored
allowed Pixi execution. The original base image and normal host profile were not
changed.

This is **VM suspension**, not guest OS sleep or physical laptop sleep. A separate
guest `pmset sleepnow` attempt failed with `0xe00002e2`; a test-only native
Electron power observer saw neither suspend nor resume. The checkpoint remained
paused unchanged, but OS sleep/wake acceptance is not established. Physical
sleep/wake and minimum-OS Desktop GUI are optional additional coverage, not
technical release blockers. CLI/backend acceptance passed in a fresh macOS15.0
guest; that is not a minimum-OS GUI claim. Closing the lid does not automatically
Pause. See [release scope and power-loss limits](release.md).

Keyboard behavior is unchanged; the requested Enter/Shift+Enter swap was dropped.

## Build and package contract

The official `@opencode/plugin/gui/vite` preset in `vite.config.ts` compiles `plugin/gui.tsx` into one CommonJS file, `dist/gui-experimental.cjs`. The package's `./gui-experimental` export must point to that **built file**, not TSX. Include `dist` in the distributed package.

The project's pinned development dependencies are `solid-js@1.9.18`, `vite@8.3.6`, and `vite-plugin-solid@2.11.15`. Run `pixi run --locked npm exec -- vite build`; the shared modules remain external. Typechecking must include `plugin/**/*.tsx` and `vite.config.ts` with `jsx: "preserve"` and `jsxImportSource: "solid-js"`.

The public contract is `Checkpoints` in `plugin/rpc.ts`, RPC id `open-enhance.checkpoints`. `pause` and `status` take `{ sessionID: string }`; `resume` requires `{ sessionID: string, revision: integer }`. Output is `Schema.Unknown`, wrapped as Standard Schema for the 2.2.6 Promise client. Status includes warnings; uncertain outcomes do not imply paused. Interrupt failures remain visible without becoming a new execution lock. Server handlers validate inputs. Register only when `checkpoints === true` and dispose with the controller.

References: [GUI](https://opencode.ai/docs/build/plugins/gui), [RPC](https://opencode.ai/docs/build/plugins/rpc).
