import { test } from "node:test"
import assert from "node:assert/strict"
import type { SetupContext, MountedSession, Command as CommandItem } from "@opencode/plugin/gui"
import { Command, ComposerPill, type ComposerPillProps } from "@opencode/plugin/gui"
import gui, { callCheckpoint } from "./gui.js"
import { Checkpoints, checkpointView, resumeInput } from "./rpc.js"

test("checkpoint response requires an explicit state, never assumes paused", () => {
  for (const value of [undefined, null, {}, { paused: true }, { state: false }]) {
    assert.throws(() => checkpointView(value), /Invalid checkpoint status/)
  }
  assert.equal(checkpointView({ state: "pending", revision: 2 }).state, "pending")
})

test("RPC uses selected session server, session ID and location", async () => {
  const calls: unknown[] = []
  const session = {
    id: "remote-session", location: { directory: "/synthetic" },
    server: { client: { rpc(definition: unknown) {
      assert.equal(definition, Checkpoints)
      return { pause: async (...args: unknown[]) => { calls.push(args); return { state: "pending" } } }
    } } },
  } as unknown as MountedSession
  assert.equal((await callCheckpoint(session, "pause")).state, "pending")
  assert.deepEqual(calls, [[{ sessionID: "remote-session" }, { signal: undefined, location: session.location }]])
})

test("disabled GUI contributes nothing", () => {
  gui.setup!({ options: {}, add: () => assert.fail("must not register") } as unknown as SetupContext<{}>)
})

test("palette action resolves session at invocation and catches server errors", async () => {
  const commands: (() => CommandItem)[] = []
  const calls: string[] = []
  let toasts = 0
  const session = (id: string) => ({ id, key: id, server: { connected: true, client: { rpc: () => ({
    pause: async () => { calls.push(id); throw new Error("offline") },
  }) } } }) as unknown as MountedSession
  let current = session("A")
  gui.setup!({
    options: { checkpoints: true }, signal: new AbortController().signal,
    sessions: { current: () => current }, toast: { show: () => { toasts++ } },
    add: (registry: unknown, contribution: unknown) => { if (registry === Command) commands.push(contribution as () => CommandItem) },
  } as unknown as SetupContext<{}>)
  const pause = commands[0]!()
  current = session("B")
  await pause.run()
  assert.deepEqual(calls, ["B"])
  assert.equal(toasts, 1)
})

test("resume requires explicit text and a valid revision; never manufactures acknowledgment", () => {
  const valid = { revision: 4, reconciliation: "Verified workspace changes using native tools", acknowledgeUnknown: false }
  assert.equal(resumeInput(valid).acknowledgeUnknown, false)
  for (const invalid of [{ ...valid, revision: -1 }, { ...valid, revision: 1.5 }, { ...valid, reconciliation: " " }]) {
    assert.throws(() => resumeInput(invalid), /Explicit reconciliation/)
  }
})

test("raw durable responses retain revision and interruption failures are not safe-close claims", () => {
  const status = { revision: 7, sessions: [], journal: [], blockedBy: ["session"] }
  assert.equal(checkpointView(status).state, "paused")
  assert.equal(checkpointView(status).revision, 7)
  assert.equal(checkpointView({ status, interruptFailures: ["child"] }).state, "paused with unresolved operations")
  assert.equal(checkpointView({ ...status, journal: [{ outcome: "unknown", acknowledged: false }] }).state, "unknown")
})

test("resume sends captured revision and user acknowledgment only to the captured server", async () => {
  const calls: unknown[] = []
  const session = { id: "captured", location: { directory: "/synthetic" }, server: { client: {
    rpc: () => ({ resume: async (...args: unknown[]) => { calls.push(args); return { state: "running" } } }),
  } } } as unknown as MountedSession
  const input = { revision: 12, reconciliation: "Reviewed edits and unknown side effects", acknowledgeUnknown: false }
  await callCheckpoint(session, "resume", undefined, input)
  assert.deepEqual(calls, [[{ sessionID: "captured", ...input }, { signal: undefined, location: session.location }]])
})

test("resume command fetches form revision without sending a resume mutation", async () => {
  const commands: (() => CommandItem)[] = []
  const calls: string[] = []
  let dialogs = 0
  const current = { id: "selected", key: "remote\nselected", server: { connected: true, client: {
    rpc: () => ({
      status: async () => { calls.push("status"); return { state: "paused", revision: 22 } },
      resume: async () => { assert.fail("opening the form must not resume") },
    }),
  } } } as unknown as MountedSession
  gui.setup!({
    options: { checkpoints: true }, signal: new AbortController().signal,
    sessions: { current: () => current }, toast: { show: () => assert.fail("valid status") },
    dialogs: { open: () => { dialogs++; return { close() {} } } },
    add: (registry: unknown, contribution: unknown) => { if (registry === Command) commands.push(contribution as () => CommandItem) },
  } as unknown as SetupContext<{}>)
  await commands[1]!().run()
  assert.deepEqual(calls, ["status"])
  assert.equal(dialogs, 1, "resume review uses a native dialog, never a clipped header form")
})

test("composer pill uses its live routed session and remote client, never a pause toggle", async () => {
  let pill!: ComposerPill
  const calls: unknown[] = []
  const signal = new AbortController().signal
  const session = (server: string) => ({
    id: "same-id", key: `${server}\nsame-id`, location: { directory: `/synthetic/${server}` },
    server: { connected: true, client: { rpc: () => ({
      pause: async (input: unknown, options: unknown) => { calls.push([server, "pause", input, options]); return { state: "pending" } },
      status: async () => { calls.push([server, "status"]); return { state: "paused", revision: 3 } },
      resume: async () => assert.fail("menu must never automatically resume or acknowledge"),
    }) } },
  }) as unknown as MountedSession
  let current = session("A")
  gui.setup!({
    options: { checkpoints: true }, signal,
    sessions: { current: () => current }, toast: { show: () => assert.fail("valid response") },
    dialogs: { open: () => ({ close() {} }) },
    add: (registry: unknown, contribution: unknown) => { if (registry === ComposerPill) pill = contribution as ComposerPill },
  } as unknown as SetupContext<{}>)
  assert.equal(pill.id, "checkpoint")
  const input = { get session() { return current } } as ComposerPillProps
  const initial = pill.show(input)!
  assert.equal(initial.run, undefined)
  assert.match(initial.title!, /not a safe-to-close/)
  const pause = initial.rows!.find((row) => row.id === "pause")!
  current = session("B")
  pause.run!()
  assert.equal(pill.show(input)!.rows!.some((row) => row.run), false, "busy menu has status only")
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(calls[0], ["B", "pause", { sessionID: "same-id" }, { signal, location: current.location }])
  assert.match(pill.show(input)!.label, /pending/)
  pill.show(input)!.rows!.find((row) => row.id === "resume")!.run!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(calls[1], ["B", "status"])
  current = session("A")
  assert.match(pill.show(input)!.label, /unknown/, "same ID on a different server has independent state")
})

test("composer and stale palette callbacks cannot bypass disconnect, pending, or busy guards", async () => {
  let pill!: ComposerPill
  const commands: (() => CommandItem)[] = []
  let connected = true
  let pending = false
  let calls = 0
  let finish!: (value: { state: string }) => void
  const current = { id: "selected", key: "remote\nselected", get pending() { return pending }, server: {
    get connected() { return connected }, client: { rpc: () => ({ pause: () => { calls++; return new Promise((resolve) => { finish = resolve }) } }) },
  } } as unknown as MountedSession
  gui.setup!({
    options: { checkpoints: true }, signal: new AbortController().signal,
    sessions: { current: () => current }, toast: { show: () => assert.fail("valid response") },
    add: (registry: unknown, contribution: unknown) => {
      if (registry === ComposerPill) pill = contribution as ComposerPill
      if (registry === Command) commands.push(contribution as () => CommandItem)
    },
  } as unknown as SetupContext<{}>)
  const input = { session: current } as ComposerPillProps
  const stale = pill.show(input)!.rows!.find((row) => row.id === "pause")!
  const command = commands[0]!()
  connected = false
  stale.run!()
  await command.run()
  assert.equal(commands[0]!().enabled, false)
  assert.match(pill.show(input)!.label, /disconnected/)
  assert.equal(pill.show(input)!.rows!.some((row) => row.run), false)
  connected = true
  pending = true
  stale.run!()
  await command.run()
  assert.equal(calls, 0)
  pending = false
  stale.run!()
  stale.run!()
  await command.run()
  assert.equal(calls, 1)
  finish({ state: "running" })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(pill.show(input)!.label, /gate open/, "running is gate state, not proof of native activity")
})

test("composer pill reports RPC errors and retains an explicit status retry", async () => {
  let pill!: ComposerPill
  const current = { id: "selected", key: "remote\nselected", server: { connected: true, client: {
    rpc: () => ({ status: async () => { throw new Error("unavailable") } }),
  } } } as unknown as MountedSession
  gui.setup!({
    options: { checkpoints: true }, signal: new AbortController().signal,
    sessions: { current: () => current }, toast: { show: () => assert.fail("status polling does not toast") },
    add: (registry: unknown, contribution: unknown) => { if (registry === ComposerPill) pill = contribution as ComposerPill },
  } as unknown as SetupContext<{}>)
  const input = { session: current } as ComposerPillProps
  pill.show(input)!.rows!.find((row) => row.id === "refresh")!.run!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(pill.show(input)!.label, "Checkpoint: error")
  assert.equal(pill.show(input)!.tone, "danger")
  assert.ok(pill.show(input)!.rows!.find((row) => row.id === "refresh")!.run)
})
