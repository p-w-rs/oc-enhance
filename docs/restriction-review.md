# Restriction review and implemented redesign

Native OpenCode permissions are authoritative. Enhancements must not compensate
for unreliable bookkeeping or incomplete attribution by blocking unrelated work.
This source review covered server hooks, evidence/source/cache handling, owned
workers/parsers, installer and GUI/RPC controls. It is not a security certification.

## Removed or redesigned

| Area | Previous restriction | Implemented behavior |
| --- | --- | --- |
| Global shell policy | Partial shell parser, Python-tool denylist, wrapper/grammar/manifest restrictions, source-validation timing tokens and injected strict instructions. | Entire feature deleted. Legacy `pixiGuard` is ignored; managed install removes it. Pixi remains only for plugin-owned Python. |
| Cross-session coupling | One paused or uncertain session blocked all new shells in the shared namespace. | Shell barrier deleted with no replacement option. Manual shell execution is outside checkpoint Pause coverage. |
| Code Mode calls | Inherited nested call IDs triggered duplicate denials. | Observe the outer envelope; nested calls remain native and nested after events do not prematurely settle the envelope. |
| Mandatory notes | Native tools/agents failed without initialized notes or checkpoint-tool permission. | Notes are best-effort and optional. Restricted agents can work without the maintenance tool. |
| Immutable objective | User steering required a new session. | Objective can be updated repeatedly in the same session. |
| Bookkeeping failure | Storage corruption/read/write failures or capacity exhaustion disabled ordinary tools. | Automatic observation warns/degrades; no latch requiring reload. Explicit Pause/Resume/update failures remain errors instead of false success. Previously observed explicit pauses are retained where possible. |
| Uncertainty lock | Unknown read, web, shell or third-party outcomes automatically blocked prompts and all tools after interruption. | Unknown outcomes warn, never automatically lock or replay operations. |
| Resume ceremony | Mandatory reconciliation essay plus uncertainty checkbox. | Explicit Resume with a current revision only. Native dialog still prevents stale-target mistakes. Independently paused children stay paused. |
| Retention | Full session/journal buffers stopped new work; uncertain history could not be forgotten. | Bounded diagnostic retention evicts unpaused leaf sessions and old observations; full protected capacity degrades observation. Explicit user-confirmed forgetting can remove uncertain history. Explicit pauses must be resumed first. |
| Evidence denies | Any read-deny rule disabled all custom retrieval, even single-source reads. | Native rule-denied inventory candidates are excluded individually; permitted sources still work. Token reads authorize only that source. Native user rejection/feedback and cancellation still propagate. |
| Whole-workspace discovery | Large inventories/extracted workspaces failed instead of returning useful coverage. | Optional subdirectory `scope`, deterministic bounded partial coverage and `truncated` reporting. |
| Coverage filters | Fixed sensitive-name/hidden/generated exclusions. | Explicit `evidencePolicy` inclusion settings plus lower file/source budgets. `.git`, `.local`, `.pixi` remain excluded. These filters are not DLP or secret scanning. |
| Shared mirrors | Different permitted subsets could reuse workspace cache identity. | Authorized inventory/scope/policy select isolated mirrors. Historical private mirrors remain local until explicitly removed. |
| Feature setup | One setup failure could remove independent features. | Checkpoint/evidence setup failures are isolated and logged; native tools remain independent. |
| Installation | Omitted enable flags retained prior enabled features without disable flags. | Explicit `--no-checkpoints` and `--no-evidence`, conflict checking and stale-guard option removal. Unrelated configuration is preserved. |
| Portability | Checkpoints existed only as local session-keyed data. | Explicit portable-note handoff export/import, saved/read using native file tools at `.opencode/handoffs/<task>.json`. No runtime state or authority transfer. |

## Protections retained, localized to plugin-owned work

- Native authorization for inventory/source reads. No plugin permission grants.
- Relative source paths, workspace confinement, regular-file/no-follow source
  and cache I/O, source/storage separation and current hash/locator validation.
- Bounded document parsing in an isolated process, parser sandbox, CPU/deadline/
  output/RSS checks; no unsandboxed fallback or automatic OCR.
- Locked Pixi runtime for owned Python, filtered worker environments, cancellation,
  process-group termination and bounded worker payloads/deadlines.
- Explicit supported-platform/host checks for managed installation, pinned
  artifacts, snapshot integrity verification and non-destructive config backups.
- Typed RPC input, current target/revision checks and visible disconnected/error
  states. No inferred safe-to-close, automatic replay or power-loss guarantees.

## Known limitations, not excuses for broader blocking

- Pause does not cover manual shells, arbitrary child processes, remote jobs or
  every MCP side effect. Native storage cannot promise sudden power-loss durability.
- Bookkeeping degradation can lose observations, and bounded history is not a
  transaction or forensic log. Failed/corrupt storage is not silently overwritten.
- Native explicit-denial classification uses the tested host's typed
  `Permission.BlockedError` inside `Tool.Error`. Unknown/error shapes propagate
  rather than accidentally treating user rejection as permission to continue.
- Local Git exclusions are respected; `.ignore` and global ignore exclusions
  are not imported. Hidden/sensitive-name filters are conservative and configurable.
- Policy settings lower discovery budgets within hard ceilings. Per-document
  extraction/runtime bounds remain fixed. Single-token reads do not require a
  whole-workspace discovery budget.
- Parser RSS is sampled, not an instantaneous hard ceiling; macOS sandbox API
  compatibility still requires testing on future operating systems.
- Handoffs are untrusted summaries, not automatically verified facts or executable
  instructions. Sharing actual code changes is separate. There are no silent
  project writes, automatic imports or Git commits.

## Validation scope

Run `pixi run --locked test`, `pixi run --locked package-acceptance`, and
`pixi run --locked cli-acceptance`. Tests include controlled SDK engine dispatch,
repeated/parallel Code Mode calls, storage-failure/uncertainty recovery, mutable
objectives, explicit pause descendants, revision-only Resume, actual native
permission-denied subset retrieval, scoped partial indexing and handoff round trips.
Packaged/CLI acceptance is synthetic and isolated; it is not real-model quality or
live Desktop rendering acceptance. Previous Desktop/VM receipts for the removed
barrier and prose dialog do not certify the new behavior. See [checkpoint semantics](checkpoints.md).
