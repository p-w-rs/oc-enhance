# Durable checkpoints (opt-in)

Server implementation: `plugin/checkpoint.ts`, targeting the public
`@opencode/plugin` **2.2.6** Promise API. This is an opt-in prototype, not a
release-ready process freezer, filesystem snapshot, transaction or rollback.

## Integration

Call `await installCheckpoints(ctx)` independently of the evidence feature in
the plugin's server setup. It registers nothing unless
`ctx.options.checkpoints === true`. Keep the returned controller and call its
`dispose()` from the plugin cleanup. Multiple location controllers coordinate in
the same server process. This module does not change native tools, permissions,
package configuration or GUI registrations.

```ts
const checkpoints = await installCheckpoints(ctx)
// Include this in the enclosing plugin cleanup:
await checkpoints?.dispose()
```

Controller methods (session IDs are strings):

- `status(sessionID)` returns `state`, scoped concurrency `revision`, scoped
  `sessions` and `journal`, `blockedBy`, `workspaceChanged`, and
  `reconciliationRequired: true`. State is `running`, `paused` or `unknown`.
  `running` means the checkpoint gate is open, not that a model/process is busy.
  Notes/journal are limited to the requested session's ancestors and descendants;
  unrelated session contents are excluded. Sibling session contents are excluded
  when querying a child.
- `pause(sessionID)` returns `{ status, interruptFailures }`. It persists the
  ancestor gate **before** enumerating or interrupting the parent/descendants.
  Pending observed calls become `unknown`. It requests native
  `session.interrupt({ resume: false })` for the discovered tree. Failure to
  enumerate/interrupt is reported and never reopens the gate. Descendants created
  later inherit the ancestor gate through live `parentID` ancestry checks.
- `resume(sessionID)` without a second argument returns
  `state: "needs-reconciliation"`; it changes nothing and does not unblock.
- `resume(sessionID, { revision, reconciliation, acknowledgeUnknown })` requires
  the current status revision and a nonempty, bounded explicit review statement.
  Unknown operations require `acknowledgeUnknown: true`. It refuses an active
  pause interruption, pending calls, or a blocked ancestor (resume that ancestor
  explicitly). It persists acknowledgment, clears only this session's pause flag,
  and installs safe continuation instructions. Independently paused descendants
  stay paused. It **does not enqueue a prompt or replay any operation**.
- `dispose()` unregisters hooks/transforms. Previously captured checkpoint tool
  executors also reject further use.

GUI/RPC integration must be supplied by the enclosing plugin. A session-ID-only
resume RPC can call `resume(sessionID)` to request review, but cannot release the
gate. An explicit confirmation form needs revision, reconciliation and a separate
unknown-operation acknowledgment field in its RPC input. Never manufacture these
values on the user's behalf. A GUI state badge can use `status.state` (or
`pauseResult.status.state`). If integration enqueues a continuation after explicit
resume, request reconciliation first, not repetition of the last operation.

## Commands

- `/enhance-pause`: persist the pause gate, then request native interruptions.
- `/enhance-forget confirm`: explicitly delete settled notes/journal for this
  session tree. Paused, pending and unacknowledged unknown work cannot be forgotten.
  A later task must initialize new notes. This is not forensic erasure of native
  conversation history or underlying database pages.
- `/enhance-status`: put the scoped structured status in a keyed session context
  entry. This is not a dedicated interactive status UI.
- `/enhance-resume`: without arguments, only publish a reconciliation request.
  To release a gate, pass JSON as command text, for example:

  ```text
  /enhance-resume {"revision":12,"reconciliation":"Reviewed workspace changes and external effects using authorized tools; unknown operation must not be retried","acknowledgeUnknown":true}
  ```

An ordinary message, including “resume” or “continue”, never unpauses a session.
Paused prompt/context and tool hooks reject execution. Read/grep/glob are **not**
exempt from the pause gate: review must occur outside that paused session using
appropriately authorized tools or external human inspection. Do not bypass native
permissions. Acknowledgment is a human decision to continue with uncertainty, not
proof that an unknown operation finished or that rerunning it is safe.

## Task notes and journal

Context instructions ask the agent to maintain `open_enhance_checkpoint` at task
start and meaningful boundaries. Origin, current and next are each limited to
1,000 characters; decisions to 12 strings of 300 characters; paths to 32
workspace-relative strings of 300 characters. Paths reject absolute paths, `..`,
empty components and backslashes. Origin is immutable after first set. No
chain-of-thought, source contents, secrets, raw prompts, tool arguments or results
belong in notes. These are untrusted agent summaries, not verified task history.

Until nonempty origin/current/next are saved, **all other tool dispatch is
rejected**, including native read-only tools. The checkpoint tool itself remains
available to initialize notes. This avoids pretending to have captured the task
when the agent never calls the maintenance tool. There is no automatic raw-prompt
capture or claim of a complete transcript/checkpoint of arbitrary internal state.
Checkpoint freshness at later meaningful boundaries remains agent-maintained.

Restricted agents must be allowed to call `open_enhance_checkpoint` under native
tool permissions. A broad deny can hide that maintenance tool (for example in a
read-only custom agent), making initialization impossible. The context hook
reports an actionable error before model dispatch when the tool is absent and
notes are not initialized, rather than inducing repeated rejected tool calls.
The plugin never adds permission grants. If desired, explicitly append a native
agent rule `{ "action": "open_enhance_checkpoint", "resource": "*", "effect": "allow" }`
in your configuration. Existing notes still permit native tool-free final
summaries when an agent reaches its step limit.

The public `execute.before` hook persists call/session/tool identifiers and a
`pending` outcome before dispatch, without inspecting/persisting arguments.
`execute.after` records observed `completed` or `error` and settlement time,
without persisting output/errors. Started/settled timestamps are local Unix
milliseconds, not a trustworthy external ordering/transaction log. An error can
still have partial side effects. Calls pending when the plugin loads become
`unknown` and hold their session/descendants until explicit review. No durable
run identity is needed to assume uncertainty conservatively on every load;
plugin reload during live work also classifies those pending calls as unknown.

The gate and checkpoint executor read durable state on every invocation and
resolve live ancestry, rather than capturing an old permission/executor snapshot.
All location instances serialize through a process-wide plugin queue because
OpenCode's location-specific storage wrappers share the plugin KV namespace.
Live observed calls are tracked across instances so loading another project does
not falsely classify those calls as crashes. Interrupted tools
can finish their after hook without deadlocking interruption. This is not
cross-process transactional storage: the host must provide one server writer and durable
`ctx.storage.set` behavior. Removing the opt-in plugin removes its enforcement.

Native storage is not a sudden-power-loss-safe external journal. OpenCode 2.2.6
uses SQLite WAL with `synchronous=NORMAL`. A test cutting VM power without an OS
shutdown recovered a pending tool as unknown but lost a recent Pause write in a
separate control session. The plugin does not change the host database pragmas.
Process restart, orderly reboot, VM suspension and unflushed power loss are
different failure modes; do not claim the last is guaranteed. Closing the lid
also does not automatically Pause: explicitly Pause and review before Resume.

## Reconciliation and safety limits

### Unattributed native shells

The 2.2.6 `shell.create.before` hook exposes command/cwd/environment but **no
session or call identity**. Direct native/manual shell execution does not pass
through the agent's tool-dispatch journal. Live Desktop acceptance exposed that
this path could bypass a session-only pause gate.

The plugin therefore checks durable state again at shell creation and blocks
**all new shells in its shared plugin namespace** while any session is paused,
has an unacknowledged unknown outcome, or has an orphaned pending call. This can
also block shell tools in unrelated sessions/projects while those pauses remain.
It never guesses attribution from command text, cwd, timing or a reusable proof.
Manual/native shells outside tool dispatch are not claimed to be journaled or
checkpoint-note initialized. Already running shells are not process snapshots
and may survive interruption. Resume paused work before deleting its native
session; unresolved retained history intentionally fails closed. Disabling the
feature removes this enforcement rather than silently resolving uncertainty.

Unit, actual SDK cross-location/descendant, and isolated Desktop-service tests
cover this barrier. Native tools and permission rules are not replaced; the
broader shell denial is an explicit consequence of opting into checkpoints.

Only a SHA-256 fingerprint of the session workspace directory string is recorded.
`workspaceChanged` detects a changed directory string, not edits, symlink target
changes, worktree identity, or source-file contents. This module deliberately
performs **no filesystem reads or indexing**: portable public hooks do not
guarantee race-free, per-component no-follow, permission-checked reads for all
arbitrary tool paths. Declared paths are metadata, not verified file hashes.

Consequently every resume requires explicit reconciliation of moved workspaces,
edits to declared/touched paths, and external effects. Use native permission-
checked tools to verify files; do not infer “unchanged” from the directory hash.
The review statement is validated but not retained (to avoid storing another
freeform user prompt). It is not automatically verified. No unknown operation is
automatically rerun, even after acknowledgment. Native interruption may not stop
noncooperative processes, network requests, terminals or background work. Already
admitted operations may continue, and new descendants can race enumeration; the
  durable ancestor gate prevents subsequent observed dispatch, not arbitrary
  operating-system activity. Completed observations after a pause can settle an
  unknown journal entry but do not clear the pause flag.

State uses the host's plugin-scoped `ctx.storage` under `checkpoints/v1`, not
committed reports or fixtures. At most 256 session note records and 256 journal
records are retained. Settled/acknowledged journal records are evicted oldest-first
when needed; pending/unacknowledged unknown records are never automatically
evicted. Session capacity exhaustion fails closed and needs explicit future
maintenance/export support; no automatic pruning of pause ancestry exists.
There is no age-based deletion or public erase API yet. Notes and relative paths
can themselves be sensitive: users/agents must not put secrets in them.

Storage is strictly decoded, including limits, identifiers, timestamps, duplicate
records and unexpected fields. Read errors, malformed state, missing state after
initialization, and write errors reject tool dispatch. A write failure latches
this controller closed until reload. Missing storage at a new installation is
indistinguishable from deliberate deletion; do not delete host plugin storage as
a way to recover paused work. This implementation cannot guarantee recovery when
the storage provider loses acknowledged writes or when hooks are bypassed.

## Focused validation

```sh
pixi run --locked node --import tsx --test plugin/checkpoint.test.ts
```

Tests use synthetic sessions and in-memory storage, covering crash-during-tool,
concurrent dispatch, pause persistence failure, interruption failures, child
ancestry, storage/schema failures, explicit resume and ordinary-message rejection,
captured executors, task initialization and scoped status privacy. They do not
establish live-server interruption behavior, cross-process atomicity, native hook
coverage, complete external-effect recovery, or release readiness.
