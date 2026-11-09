# Security and deployment boundaries

## Fail closed

- Evidence is off by default. Unsupported permission APIs do not receive custom filesystem tools.
- Source inventories are authorized before content extraction. Exact `allowed_paths` prevent newly appearing files from entering the authorized scan.
- Read-deny rules conservatively disable workspace-wide evidence search; broad directory approval must not bypass a denied child.
- Source paths are relative and confined to the session workspace. Python walks every ancestor with `openat`/`O_NOFOLLOW` and rejects symlinks and non-regular files. Source and storage overlap is refused; cache writes/deletions use pinned directory descriptors rather than following mirror paths.
- Git exclusions are applied independently of `.ignore` negations. Evidence reads recheck current discovery policy, not merely old source hashes.
- Retrieved contents are untrusted data, never instructions. No retrieved text is executed.
- Hashes establish which bytes were observed, not factual truth or trustworthiness.

## Resource limits

5,000 eligible sources, 96 MiB source budget, 64 MiB extracted text, 10,000 evidence units; text files up to 2 MiB, documents up to 20 MiB, PDFs up to 200 pages. Oversized workspaces must be narrowed explicitly.

PDF/DOCX parsing occurs in a disposable Python subprocess launched through Pixi. Input bytes are passed on stdin; original paths are not passed. Before parsing, a macOS sandbox denies source-file reads, file writes, networking and process creation; only Python/runtime resources are readable. CPU is limited to five seconds, wall time to twelve seconds, extracted text to 4 MiB, and an external watchdog samples total parser-tree RSS against a 512 MiB budget. macOS does not provide a usable hard address-space limit here: transient memory overshoot between samples remains possible. Sandbox setup/monitoring failure refuses extraction rather than falling back to an unsandboxed parser. The native sandbox API is deprecated, so future macOS compatibility needs acceptance testing.

Workers accept up to 2 MiB of request JSON and emit up to 2 MiB stdout / 64 KiB stderr, with deadlines. Cancellation and plugin unload terminate the owned process group and await closure; parser children do not detach from that group. Workspace locks serialize index mutations; manifests and mirror updates are atomic. Corrupt manifests are rebuilt. Worker environments exclude inherited credentials, OpenCode configuration, and loader-injection variables. The Node launcher executes Pixi without a host shell; Pixi resolves the trusted package-owned task. All plugin-owned Python subprocesses enter via Pixi, including descriptor handoffs and document parsing. There is no direct-interpreter fallback.

## Data retention and privacy

The plugin data directory contains source copies and extracted private content. Protect it like the original projects; do not commit or share it. CLI/setup create new files with a restrictive umask. There is no automatic retention policy or encryption layer yet. Removing a source removes its current mirror entry; forensic erasure of old filesystem/index pages is not promised.

Known secret filenames, hidden directories and vendor/build trees are excluded. This is a conservative filename policy, not secret scanning. An ordinary source or document can still contain confidential material. When a cloud agent receives local evidence, that evidence can leave the Mac through its selected provider.

Current discovery honors local Git exclusions but does not import `.ignore` or global ignore files. Such files cannot unignore a Git-excluded source, but their additional exclusions are not yet supported; use a narrow workspace and local `.gitignore` rules. Do not treat this prototype as an enterprise data-loss-prevention system.

## Installation and supply chain

ColGrep archive SHA-256, model revisions and Python/npm dependencies are pinned. Setup records installed model-file hashes and the binary hash. Setup requires network access; the evidence search path uses a local encoder and an explicitly located local ONNX Runtime.

Full development and production JavaScript dependency audits are clear after scoped glob/minimatch migrations and a maintained source-rebuilt GitLab provider using patched Zod. The unsafe declaration-breaking Zod override was rejected. The shipped provider archive preserves MIT licensing, provenance, sources, a build lock and strict type contracts; see `docs/dependency-assessment.md` and `vendor/README.md`. Fresh extracted-package installation also verifies the portable file dependency and full audit. These changes do not rewrite the precompiled native CLI or installed Desktop application. Do not expose development test servers to untrusted networks or infer production readiness solely from a clear audit.

## Release review and future hardening

- Resolve or explicitly assess upstream npm advisories and re-run the audit.
- Verify installation on a clean macOS environment, without developer tools/global Node/Python on PATH.
- Test packaged plugin loading, supported-host matrix, real permission prompts and model dispatch.
- Verify sandbox/resource limits on minimum supported macOS. Additional hostile-document fuzzing remains useful hardening, not a claim of exhaustive parser safety.
- Incremental manifest storage/retention is future work; bounded cache recovery and interruption behavior are tested already.
- Realistic long-context decision evaluation is required before any recommendation to enable System 1. System 1 remains evaluation-only and is not a release feature.

Required technical evidence is enumerated in `docs/release.md`. These reviews do
not authorize publication, change the license, or certify every third-party
native dependency.

## Enabled policy/checkpoint boundaries

`pixiGuard` and `checkpoints` are independent opt-ins. The guard never silently rewrites commands or grants a native permission. It cannot observe arbitrary opaque executables, MCP server internals, remote jobs, LSP/formatter processes or other external execution surfaces; it is not a hostile-agent sandbox.

Checkpoints are private task summaries and outcome metadata in OpenCode's plugin storage. They are not filesystem/process snapshots or automatic verification of external side effects. Pausing persists a gate before requesting native interruption. Noncooperative operations may outlive interruption, so no badge promises unconditional safety to close the laptop. Resume requires explicit reconciliation and separate acknowledgment of unknown operations; acknowledgment never authorizes blindly repeating them. Disabling/uninstalling the plugin removes its enforcement and does not undo work. See `docs/checkpoints.md` for retention and concurrency assumptions.

Native storage is not guaranteed to preserve its latest acknowledged write after
unflushed power loss. A hard VM power cut lost a recent Pause write; native
OpenCode SQLite uses WAL with `synchronous=NORMAL`. The plugin does not change
host database settings. Explicit Pause, normal reboot and crash-recovery checks
must not be advertised as a sudden-power-loss or automatic lid-close guarantee.
