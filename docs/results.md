# Findings — 2026-11-08

Machine: Apple M2 Max, 96 GB unified memory, 38-core GPU. This is an exploratory prototype acceptance record, not a production-readiness certification.

## Feature decisions

| Enhancement | Decision | Reason |
|---|---|---|
| Source-verified document search | Keep opt-in | Adds extraction/provenance and useful semantic discovery, but quality varies by corpus. Never replace native exact/exhaustive search. |
| Semantic code search | Experimental; native preferred | The real code sample did not beat its scripted lexical baseline, even after improving file diversity. |
| Default hybrid fusion | Do not assume it wins | Initial synthetic run was weaker than semantic-only. Exposed as an explicit experimental mode, not an automatic superiority policy. |
| System 1 tool selection | Shadow evaluation only | Small routing suite does not establish useful gains over a cheap heuristic, much less the selected OpenCode agent. |
| Shell rewriting/wrapping | Do not implement | Native facilities already cover the proposed generic output/timeout features; no demonstrated benefit justifies another execution layer. |
| Generic tool-output enhancement | Defer | No independently demonstrated gap yet. |

## System 1: actual measurements on this Mac

32 handcrafted short requests; seven tool descriptions; each request also evaluated with reversed option order. Original released precision, `mlx-decision==1.2.0`, prefix cache disabled, one resident model at a time. Downloads/load time excluded from request latency.

| Model | Expected choice | Median | p95 | Peak MLX memory | Same choice after reordering |
|---|---:|---:|---:|---:|---:|
| Joey-1 | 31/32 | 160 ms | about 162 ms | 3.84 GB | 32/32 |
| Elephant-1 | 32/32 | 668 ms | 674 ms | 16.03 GB | 32/32 |
| Deterministic heuristic | 31/32 | no inference | — | negligible | deterministic |

This is **not** native OpenCode task success, arbitrary argument generation, safety validation, or representative long-context traffic. The model runtime's parity with original serving implementations was not independently re-established here. Elephant's one-case improvement over this heuristic does not justify approximately 0.67 seconds and a resident 16 GB on every tool call. No decision model is enabled in the plugin.

The first Elephant download hit a two-minute command deadline; a resumed run completed and produced the measurements above. Joey's first harness run exposed a response-object API mismatch, fixed before its successful measurement.

## Retrieval: evaluation and an observed regression

23 synthetic queries: 21 answerable and two deliberately unanswerable. Code, prose, CSV, native-text PDF/DOCX, version conflicts, and multi-source questions. Ten independently source-located questions from a nearby project were also evaluated read-only. Both suites use two repeats; repeated trials are not independent new tasks.

The initial policy returned five evidence windows. Synthetic all-source recovery was 81.0% for scripted term-OR ripgrep/BM25, 95.2% for semantic search, and 90.5% for fusion. But the nearby-project sample exposed a failure: adjacent windows of a large file consumed the budget. Semantic all-source recovery was only 30%, versus 40% for the scripted file-level grep baseline.

That regression was **not** hidden or called a win. The next policy retrieves a wider candidate pool and returns at most one evidence unit per source file. This is an exploratory design correction selected using these observations, not an untouched held-out confirmation. Additional unfamiliar projects are needed before a general quality claim.

### Final post-correction aggregates

Two serial repeats per query. "All sources" is the share of answerable queries whose expected source files were all returned. "Recall" is mean source-file recall at five results. No fallback runs occurred.

| Corpus / method | Recall | All sources | Median latency | p95 |
|---|---:|---:|---:|---:|
| Synthetic / scripted rg | 81.0% | 81.0% | 8 ms | 11 ms |
| Synthetic / extracted BM25 | 81.0% | 81.0% | 36 ms | 41 ms |
| Synthetic / semantic | 95.2% | 95.2% | 805 ms | 859 ms |
| Synthetic / fusion | 88.1% | 85.7% | 800 ms | 858 ms |
| Nearby code sample / scripted rg | 61.7% | 40.0% | 17 ms | 20 ms |
| Nearby code sample / extracted BM25 | 61.7% | 40.0% | 84 ms | 86 ms |
| Nearby code sample / semantic | 51.7% | 40.0% | 839 ms | 857 ms |
| Nearby code sample / fusion | 53.3% | 40.0% | 861 ms | 885 ms |

**Decision:** semantic is the default mode only when this optional evidence tool is explicitly selected; fusion remains experimental. Native code/exact/exhaustive search remains preferred. Source verification and document extraction are the defensible additions. Evidence itself remains off by default. No automatic rule claims to know whether the enhancement will beat native behavior on a new request.

### Interpretation limits

- Scripted ripgrep term extraction is not an intelligent native agent choosing queries. Native agent behavior was separately simulated below.
- A fixed file-recall metric does not measure whether the selected passage actually entails the answer. Original-byte verification is a separate property.
- PDF/DOCX extraction is a pipeline capability difference, not proof that native OpenCode cannot read documents.
- Semantic/fused searches returned passages for unanswerable queries. They are not abstention systems. Empty and nonempty results must both be interpreted cautiously.
- Startup/indexing, compilation caches, and ordinary machine load affect timings. These are not dedicated-hardware performance guarantees.

## Small agent workflow simulation

Separate agents without gold access answered the same four synthetic questions: an ownership/escalation chain, retention changes across releases, a PDF recovery check, and an unsupported uptime guarantee.

- **Native:** three supported correct answers and appropriate insufficient-evidence response; 10 native tool calls. Native PDF reading worked; the available native reader rejected DOCX as binary.
- **Enhanced:** same three supported answers and appropriate insufficient-evidence response; four semantic-search calls plus one focused grep, and one separate instruction-file read.

These were unblinded, single runs. They do not establish token savings, latency superiority, native model inferiority, or a statistically reliable call-count improvement. They support keeping targeted extraction/search available rather than forcing every task through it.

## Safety and integration acceptance

Latest locked suite: **69 Python + 80 Node/SDK tests passed**, including the
unavailable-maintenance-tool diagnostic before model dispatch. Earlier counts
below record the historical stages, not the current suite size.

Final `pixi run --locked test`: **66 Python tests and 23 Node/SDK tests passed**, plus TypeScript checking. A separate clean-environment semantic smoke passed with temporary HOME, Pixi-only PATH and dead HTTP/HTTPS proxies; it returned the expected PDF page through the local backend with original source files unchanged. This is not a clean-machine installation test.

The suite includes adversarial storage symlinks, source/storage overlap, ancestor replacement, changed ignore policy, corrupt manifests, malformed backend output, stale/deleted sources, concurrent requests, permission denials, large inventories, environment credentials, cancellation, timeout, and process-group cleanup.

Independent review caught real issues. Fixes include descriptor-relative cache operations, no-follow ancestor traversal, source/storage overlap rejection, current-ignore checks on evidence reads, corrupt-cache recovery, and a 2 MiB inventory transport budget. macOS rejected a proposed `/dev/fd` working-directory approach; a fresh child now `fchdir`s a pinned descriptor before executing ripgrep. A concurrent lock creation race is covered by the parallel-search test.

A final review also found a pathname-based mirror handoff and FIFO lock hang. Semantic subprocesses now inherit and `fchdir` a pinned mirror descriptor; lock entries are opened nonblocking and checked as regular files. Dedicated replacement-at-launch and FIFO regressions pass, and the actual offline semantic path was rechecked after those fixes.

OpenCode SDK tests use isolated HOME/XDG directories, disabled networking and model fetching, actual Python lexical extraction/read, and synthetic sources. The repo-owned CLI reports 2.2.6. Direct executor tests are **not** complete model-tool-dispatch tests.

## Historical blockers (superseded by follow-up acceptance below)

- Correction after inspecting the desktop installation: the PATH CLI is 2.0.18, but OpenCode Desktop and its running bundled executable are 2.2.6, matching the official desktop update feed. There is no desktop-version upgrade blocker. The older standalone CLI still lacks the required plugin capability if used as the host. The owner's installation/configuration was not changed.
- Initial npm audit reported **31 upstream findings: 25 moderate and six high**. The 0.2.0 candidate's compatible repairs reduce that to **28: 22 moderate and six high**. Passing behavioral tests does not resolve the remaining advisories.
- Clean-Mac and live Desktop acceptance remain outstanding. Fresh extracted-package acceptance now exists (see below).
- Document parsing now uses a disposable macOS sandbox, CPU/deadline/output limits and a sampled memory watchdog. It still has no instantaneous hard memory ceiling, OCR, visual retrieval or forensic erasure guarantee.
- No representative end-to-end evaluation across different selected agents and model families.

Raw reports, local case descriptions, source mirrors and model files remain in `.local/` or plugin-owned application storage, not this public findings document.

## 0.2.0 candidate: Pixi policy and durable pause

**Historical behavior below:** these results describe the earlier `pixiGuard` and blocking-checkpoint implementation, not the current redesign. The guard, mandatory notes, immutable objectives, uncertainty locks and prose Resume requirements have since been removed. See [current restriction review](restriction-review.md). Prior receipts do not certify current-source Desktop behavior.

The earlier candidate added independent `pixiGuard` and `checkpoints` options, a built desktop GUI entry, explicit Resume review, and typed server RPC. That evaluation did not change the owner's global configuration or publish a package.

- Direct Python commands, related tools, extensionless Python scripts and common wrappers are inspected before execution. Supported source inspections use attributed native read permissions. Authorized Pixi workspace/script preparation is allowed; ambiguous shell constructs fail closed. This is not an OS-wide process sandbox.
- Plugin-owned Python now enters through Pixi too, including the evidence worker, document parser and descriptor-relative native-backend launchers.
- Checkpoints require initial origin/current/next notes, persist observed tool starts/outcomes, gate descendants, and survive test-server restart. Unknown operations are never replayed. Resume requires an explicit review statement and separate acknowledgment; file-change reconciliation is not an automatic snapshot.
- Desktop Pause/Resume uses the documented ComposerPill row above the composer, with header status/review and fallback actions. Native Send/Stop remains intact. GUI contribution tests/builds are not live Desktop acceptance.
- Real deterministic fake-SSE model dispatch exercises guard rejection before spawning and journal writes before native execution. Separate SDK tests exercise shared plugin storage across two project locations and native session deletion. No paid models or external model requests are used.

Independent review exposed a cross-location lost-update race, unrelated deleted sessions breaking recovery, and ambiguous partial Resume success. Fixes include process-wide coordination of the shared plugin KV, persisted ancestry (including intermediate ancestors), scoped revision tokens, durable interruption-failure metadata, and explicit reporting when the gate opened but continuation admission is unconfirmed.

The Python distribution audit initially reported old parser/test-runner advisories. After updating to `pypdf==6.21.4` and `pytest==9.0.3`, pip-audit reported no known vulnerabilities in the inspected installed distributions. This does not audit every native/Conda library.

Fresh archive acceptance successfully installed the locked Pixi/npm environments offline under an isolated HOME, with only system tools on the initial PATH and reused dependency caches. The extracted package loaded the real SDK adapter with all three features enabled, retained native tools, registered checkpoint commands and returned verified lexical evidence. This is not a clean-machine or live Desktop test.

Current release receipts are generated under `.local/release/` and tied to the source fingerprint. `pixi run --locked release-check` intentionally refuses a production-ready verdict while any gate is missing or failed. See [release gates](release.md).

### Follow-up remediation and actual CLI testing

The prior 28 findings were three underlying advisories plus affected dependency chains. Scoped glob/minimatch migrations and a properly source-rebuilt GitLab provider now yield zero findings in both full development and production npm audits. The naive Zod override was rejected because it weakened declaration types; the maintained rebuild preserves strict types and ships public sources, license, provenance and build lock. Fresh extracted-package installation and audit passed with the shipped relative archive dependency. Details and compatibility evidence are in [dependency assessment](dependency-assessment.md).

The project-owned native CLI was also run through Pixi with a private server and isolated HOME/configuration. It loaded the plugin from its real package entry, created a session, dispatched a checkpoint tool, refused a direct Python command before it could create a marker, and completed an allowed Pixi task. The provider was a controlled local SSE endpoint, not an actual LLM; this verifies native CLI/plugin integration, not model quality, live Desktop rendering or security remediation of the compiled CLI itself. `pixi run --locked cli-acceptance` reproduces that test and is part of the release gate. CLI/server acceptance is work that can be automated on this Mac, not inherently an external-machine blocker.

Actual installed Desktop 2.2.6 subsequently passed isolated-profile checks for
composer rendering, explicit native Resume review, native Stop, checkpoint
interruption, permission Deny, server reconnection, and app close/reopen with a
persisted paused revision. Live checks exposed and fixed a clipped header form
and a separate direct-native-shell pause bypass. The latter now fails closed
across the shared namespace because the public shell hook has no session
identity; SDK and unit regressions cover that conservative boundary. Physical
sleep/wake, minimum-OS GUI and independent physical hardware are separate coverage
categories. See [Desktop acceptance](desktop.md) and the current [release scope](release.md).

### Expanded acceptance

Uncached host installation passed setup, model downloads, diagnostics and native
CLI acceptance. A fresh macOS 26.6.2 UTM guest passed those stages and the then
current 69 Python + 79 Node tests without copied host dependency caches; only
standalone Pixi was separately provisioned as a project tool.

Two actual anonymous `opencode/big-pickle` synthetic workflows passed ordinary
read/calculation and direct-Python policy pressure: checkpoint maintenance,
native read, calculation through locked Pixi, and no forbidden marker. An initial
pre-checkpoint read was blocked and safely recovered. Earlier incorrectly
restricted permission fixtures failed and were retained, not counted as passes.
These two workflows do not establish broad model quality or a recommendation.

Actual Desktop edge cases and active native parent/child interruption passed.
VM memory suspension/resumption preserved the paused revision and descendant
gate; a shell stayed blocked until explicit native Resume. Guest OS sleep was
rejected with `0xe00002e2` and produced no native power events. Physical host
sleep remains unverified. Fresh macOS15.0/24A335 guest setup, model downloads,
diagnostics, the then-current149 tests and native CLI subsequently passed without
copied dependency caches. Minimum-OS Desktop GUI is not claimed. Current-source
receipts and required checks are defined by [release gates](release.md), not
historical counts or earlier source fingerprints in this narrative.

An additional unflushed VM power-cut test exposed a native-storage limit: the
pending tool became unknown, but a recent Pause write in a separate control
session was lost. OpenCode uses SQLite WAL with `synchronous=NORMAL`; no native
database settings were changed. This failed test is retained and is not renamed
a passing orderly reboot. Physical sleep/wake is optional final coverage, not a
release requirement or an automatic-pause promise.
