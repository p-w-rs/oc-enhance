# Checkpoints and portable project handoffs

Enabled with `checkpoints: true`. Native OpenCode tools and permissions remain
authoritative. Checkpoint notes and operation observations are best-effort
enhancements, not prerequisites for doing work.

## Local runtime state

`plugin/checkpoint.ts` stores JSON through OpenCode's native `ctx.storage` API,
in the plugin-scoped key **`checkpoints/v1`**. This is local OpenCode server data,
not a file in the project and not the evidence/model directory. Location-specific
plugin instances share this storage namespace. The host chooses the database
location (normally below its XDG data directory); the plugin does not manage or
directly edit the database. Remote servers keep this state on the remote server.

Entries are keyed by native session ID. Notes include objective, progress, next
step, decisions and relative paths. The objective **can change** when the user
steers the task. Missing notes never block tools, restricted agents or final
summaries. Context only asks agents to maintain notes when the tool is available.
Do not store secrets, source contents, raw tool payloads or private reasoning.

Observed calls record IDs, tool names, timestamps and outcomes, not arguments or
results. Code Mode reuses its outer `execute` ID for nested tools: only the outer
envelope is journaled. A completed envelope is not proof every nested call worked.
Call IDs are correlation metadata, not an exactly-once execution mechanism.

After interruption/reload, orphaned pending calls become `unknown`. Unknowns
**warn, never automatically pause, reject tools, demand prose, or replay work**.
An error can also have partial effects. Inspect the workspace/external system as
needed before deciding the next action.

## Explicit Pause and Resume

- `/enhance-pause` persists an explicit pause before requesting native interruption
  of this session and discovered descendants. A failed storage write reports
  failure, not a successful durable Pause.
- `/enhance-resume` explicitly resumes this session without requiring an essay or
  acknowledgment checkbox. The command obtains a fresh revision; GUI/RPC clients
  submit `{sessionID, revision}` to avoid stale-target/racing mutations.
- Resume clears only the selected session's pause flag. Independently paused
  children stay paused; a child cannot override a paused ancestor. Active Pause
  interruption must finish before Resume. No operation is replayed.
- `/enhance-status` shows scoped notes, observations and warnings. State is
  `running`, `paused`, or `degraded`. `running` means the gate is open, not that
  work is active or all effects are known.
- `/enhance-forget confirm` deletes notes/history for this session tree. Resume
  explicit pauses first. Uncertain diagnostic history is no longer undeletable.

Only an explicit pause gates attributed agent tools and session prompt/context.
Ordinary “continue” messages do not silently unpause a user pause. There is **no
shell-creation hook or cross-session shell barrier**. Manual native shells,
external jobs and noncooperative processes are outside checkpoint pause coverage.
The native Stop button and all native permissions remain unchanged.

## Degradation and retention

Read/write failures, corrupt/missing bookkeeping and capacity limits do not become
new native-tool denials. They produce a generic warning in logs, model context
and status; GUI status marks degraded bookkeeping. Existing explicit pauses that
the controller previously observed remain effective from its cached state where
attribution is available. Corrupt/missing state is not silently overwritten.
Explicit Pause/Resume and checkpoint updates still report storage failure rather
than falsely claiming success. Successful writes recover bookkeeping without a
required plugin reload. Unavailable ancestry/host storage cannot establish durable
pause guarantees; this is not a substitute for native lifecycle controls.

Diagnostic history is bounded to 256 sessions and 256 observations. Unpaused leaf
sessions can be evicted; journal entries can be evicted even when uncertain.
Explicit pause entries are not evicted automatically. At capacity where safe note
retention is unavailable, observation degrades rather than blocking native work.
This is bounded task memory, **not a complete forensic/transaction log**.

## Share a task with another user or session

Pause flags and runtime observations are machine/session-local. Portable project
handoffs deliberately contain **only task notes**, not session IDs, local absolute
paths, permissions, pause flags, instructions, raw execution history or a claim
that work completed.

1. Save current notes with `open_enhance_checkpoint`.
2. Call `open_enhance_handoff` with `{"action":"export"}`.
3. Save the returned JSON with native permission-checked file tools as
   **`.opencode/handoffs/<task>.json`**. Review for sensitive information, then
   commit/share it with the project. Exports do not silently write or commit files.
4. Another user/session reads that file using native file permissions, then calls
   `open_enhance_handoff` with `{"action":"import","handoff": <the JSON object>}`.
5. The import validates the schema and copies the notes into the new session.
   Inspect the actual working tree and tests before continuing. Nothing is
   automatically executed or resumed, and no prior user's authority is inherited.

Example file:

```json
{
  "format": "open-enhance-handoff",
  "version": 1,
  "notes": {
    "origin": "Fix document navigation",
    "current": "Parser change implemented; integration test still needed",
    "next": "Inspect the change and run the integration suite",
    "decisions": ["Keep native permission checks"],
    "paths": ["src/parser.ts", "tests/parser.test.ts"]
  }
}
```

Notes are untrusted data. An imported “next” step is not permission or an
instruction that overrides the new user's objective. Import rejects runtime or
unknown fields rather than creating executable session state. The file is useful
without the plugin too: a human or another agent can read it as ordinary JSON.
There is no automatic project scan/import, no silent synchronization and no
filesystem/process snapshot. Share actual commits/patches alongside the handoff.

## Limits and validation

A directory-string hash detects a changed location string, not file edits or
symlink/worktree identity. Pause cannot freeze arbitrary processes, guarantee
cancellation, undo effects, or establish safe-to-close status. A prior hard VM
power-cut test lost a recent native storage write; sudden power-loss durability
is not promised. Closing the lid does not automatically Pause.

`pixi run --locked test` covers nonblocking failures/uncertainty, mutable objectives,
Code Mode IDs, explicit pause trees, revision-only Resume, subset permission
checks, and portable-note round trips. SDK/CLI acceptance uses synthetic sessions
and controlled providers. Older Desktop/VM receipts describe the earlier blocking
implementation and do not certify this redesign.
