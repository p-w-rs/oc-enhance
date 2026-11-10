# Release gates

Version 0.2.0 is an opt-in macOS arm64 release candidate. Technical readiness is
not a production security certification or authorization to publish. The package
remains `private: true` and `UNLICENSED`; licensing and publication require a
separate owner decision.

## Reproduce

```sh
pixi run --locked setup
pixi run --locked test
pixi run --locked package-acceptance
pixi run --locked release-check
```

`release-check` fails closed for missing, stale, failed or incomplete evidence.
It validates receipts against the current source/tests/docs/locks/bundle
fingerprint; previous passing evidence is never silently rebound after edits.
Raw logs, synthetic test installations, models and aggregate receipts remain in
`.local/`, outside the published package.

## Required technical gates

- Python and Node/SDK tests, TypeScript, GUI bundle and package-content checks.
- Native CLI dispatch: checkpoint maintenance, direct-Python rejection and an
  allowed locked Pixi task, with a controlled local SSE provider.
- Installed Python-distribution and full JavaScript dependency audits.
- Fresh extracted-package installation and packaged adapter/backend acceptance.
- Uncached extracted-package setup/model provisioning, diagnostics and native CLI.
- Fresh macOS **15.0 / 24A335** Apple Silicon guest with no copied host dependency
  caches: standalone Pixi provisioning, setup/models, diagnostics, tests and CLI.
  A VM is accepted for this portability gate; an independent physical Mac is
  additional coverage, not a claim inferred from the VM.
- Live Desktop **2.2.6 on macOS 26.6.2**: native composer controls and review,
  explicit Resume, empty-form rejection, native Stop/permission Deny, shell gate,
  streaming Pause, app reopen, stale review/session-switch and service-crash edges.
- Actual native active-parent/child interruption with the descendant gate retained.
- Orderly guest shutdown and cold boot during active native tool execution:
  checkpoint recovery, unknown-operation gating, no replay, descendant confinement
   and explicit Resume before new execution when the user had paused it.
- Small actual anonymous-model ordinary and policy-pressure synthetic workflows.
  These are integration acceptance, not broad accuracy or model recommendations.

`scripts/release-evidence.mjs` lists the concrete receipt/check requirements.
`releaseReady` in the report means those technical gates passed for that exact
fingerprint and documented scope. `publicationReady` remains false: this workflow
never changes the license or publishes the package.

## Optional coverage and explicit limits

Physical laptop sleep/wake, minimum-OS Desktop GUI and an independent physical
Mac remain additional coverage, not technical release blockers. The owner may
test physical sleep/wake at the end. Closing the lid does **not** automatically
Pause or establish safe-to-close status.

VM memory suspension/resumption passed previously, preserving the paused revision
and descendant gate. Guest OS `pmset sleepnow` was rejected with `0xe00002e2` and
produced no native power events. Neither result is a physical-sleep claim.

An **unflushed hard VM power cut** during execution recovered the pending tool
as unknown but lost the latest Pause write in a separate control session.
OpenCode 2.2.6 uses native SQLite WAL with `synchronous=NORMAL`; the plugin does
not alter host database settings and cannot promise every acknowledged write
survives sudden power loss. Normal reboot, process crash, VM suspension and
physical power loss are distinct tests.

Other security boundaries remain unchanged: native permissions are preserved;
Pixi policy is not an OS-wide sandbox; unknown operations are never automatically
replayed; notes are unverified, not a filesystem snapshot. Uncertainty and
bookkeeping failures no longer create execution locks. The namespace-wide
checkpoint shell barrier has been removed: manual shells lack session attribution
and are outside pause coverage. Older Desktop shell-gate receipts describe the old
implementation, not acceptance of this change. See the [restriction review](restriction-review.md).
The parser sandbox has a sampled RSS watchdog, not an instantaneous hard memory
ceiling, and Apple's deprecated sandbox API fails closed if unavailable.

The maintained provider archive and scoped dependency migrations do not rewrite
precompiled OpenCode CLI/Desktop binaries. Audits do not comprehensively cover
native/Conda libraries. See [dependency assessment](dependency-assessment.md),
[checkpoint limits](checkpoints.md), and [Desktop evidence](desktop.md).
