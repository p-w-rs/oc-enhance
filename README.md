# open-enhance

**Opt-in enhancements for OpenCode V2. Release candidate under validation—not yet approved for production release.** Native tools and their permissions remain available; enabled policies add explicit execution gates.

macOS Apple Silicon only (macOS 15+; fresh CLI/backend acceptance on 15.0 and 26.6.2, Desktop acceptance on 26.6.2). Pixi **0.81.0 or newer** is the only separately installed project tool, beyond macOS and the OpenCode host. Development uses a repository-owned OpenCode SDK/CLI, not the system installation.

## Status

- Implemented: strict Python-through-Pixi policy, cross-language Pixi preference, durable pause/checkpoint commands, desktop composer controls with native Resume review dialog, local evidence search, sandboxed native-text PDF/DOCX extraction, source hashes and citations, external indexes, bounded cancellable workers, permission-aware OpenCode tools, synthetic evaluations.
- Experimental: System 1 tool-ranking **evaluation only**. It never intercepts or executes tool calls.
- Deliberately absent: shell rewriting, automatic tool hiding, prompt rewriting, general-purpose persistent agent memory, and automatic replacement of native search. Checkpoints contain bounded task summaries and observed operations, not private reasoning or full process snapshots.
- Not implemented: OCR, visual page retrieval, learned document-specific retrieval, a persistent inference service, or full end-to-end task-success evaluation.
- Technical release readiness requires current-source tests, audits, fresh guest installation, live Desktop checks, and reboot recovery. Physical sleep/wake is optional. Publication and licensing require separate authorization. See [release gates](docs/release.md), [security](docs/security.md), and [evaluation](docs/evaluation.md).

The evidence adapter requires a host with `permission.assert` (tested with **OpenCode 2.2.6**). It fails closed when opted in on unsupported hosts, including 2.0.18. Setup does not upgrade OpenCode or change global configuration.

## Setup

### Install in your own OpenCode Desktop

Requires **OpenCode V2 2.2.6+** (tested with 2.2.6), **macOS 15+ on Apple Silicon**,
and **[Pixi](https://pixi.sh) 0.81.0+**. No separate Python, Node, npm or model
service is needed. This is a release candidate; review the safety limits below.

Download this repository with **Code → Download ZIP**, extract it, open a terminal
in the extracted folder, and run:

```sh
pixi run --locked install --checkpoints --pixi-guard --evidence
```

Or, if you already have Git:

```sh
git clone https://github.com/p-w-rs/open-enhance.git
cd open-enhance
pixi run --locked install --checkpoints --pixi-guard --evidence
```

Each flag explicitly enables that feature; omit any you do not want. Installation
downloads the evidence backend/model during setup, builds the GUI and prepares an
independent snapshot under `~/.local/share/open-enhance/releases/` (or
`$XDG_DATA_HOME/open-enhance/releases/`). It then backs up and updates your global
OpenCode JSON/JSONC configuration, preserving comments, unrelated plugins/settings
and existing open-enhance options. It records Pixi's absolute path for Desktop.
It does not select a model, change native permissions, or restart OpenCode.
Desktop's bundled CLI is detected even when an older CLI is on your terminal PATH.

Once installed, look above the composer for **Checkpoint: …**, **Pause**, and
**Resume…**. Resume always opens a review dialog. **Gate open** means work is
permitted, not that the agent is working or that it is safe to close the app.
For evidence, ask the agent to use `open_enhance_search` for a document question;
native grep/glob/read remain preferred for exact code searches.

Config reload is automatic; use `/reload` if needed. You can remove the downloaded
source folder after a snapshot installation. Keep snapshots and Pixi installed.
Update between active tasks: download the new source (or `git pull --ff-only` in
a clean checkout), then rerun the install command. Existing enabled features stay
enabled; disable them explicitly in plugin options if desired. Recovery commands:

```sh
pixi run --locked install --rollback
pixi run --locked install --uninstall
```

Rollback requires a prior managed installation. Uninstall removes only this
plugin's config entry; snapshots, evidence data and stored checkpoints remain.
If installation reports an existing lock or incomplete snapshot, inspect the
reported path and confirm no installer is running; do not delete broad data trees.

With checkpoints enabled, agents must be permitted to maintain
`open_enhance_checkpoint`. Custom/read-only agents that deny it fail closed;
installation deliberately does not broaden their permissions. See
[checkpoint limits](docs/checkpoints.md) and [desktop controls](docs/desktop.md).

OpenClaude can be installed alongside this plugin using its own
[`pixi run --locked install`](https://github.com/p-w-rs/open-claude#install).
Neither installer replaces the other's config entry. Source remains `UNLICENSED`;
installation instructions are not a license grant or production certification.

### Development setup

From this checkout:

```sh
pixi run --locked setup
pixi run --locked doctor
pixi run --locked test
pixi run --locked build
```

Setup installs locked dependencies, fetches a SHA-256-verified ColGrep 1.8.5 macOS binary, and downloads a revision-pinned LateOn-Code-edge encoder. ONNX Runtime is a locked local dependency. No Homebrew, Docker, global Python/Node/Rust, or separate model service is required.

Default data location:

```text
~/Library/Application Support/open-enhance/
  bin/              # verified native backend
  models/           # pinned retrieval and optional decision models
  workspaces/       # policy-filtered source mirrors and manifests
  data/             # ColGrep's external indexes
  cache/            # compilation caches
  installation.json # installation receipt and artifact hashes
```

To contain data inside this checkout, set an **absolute** `OPEN_ENHANCE_HOME` ending in `.local/data` before setup and each CLI invocation, and set the same directory in plugin options. Source and storage trees must not overlap: that mode cannot search this checkout itself. The default is a stable application-data directory so package upgrades do not discard indexes.

Models and third-party components retain their own licenses. `models.lock.json` records model identities. System 1 models are not downloaded by ordinary setup; the explicit decision evaluation task downloads the selected model.

## Python policy and pause/resume

All features are independently opt-in:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/absolute/path/to/open-enhance",
    "options": {
      "pixiGuard": true,
      "checkpoints": true,
      "evidence": false,
      "pixiExecutable": "/absolute/path/to/pixi"
    }
  }]
}
```

`pixiExecutable` is needed when Desktop's PATH does not include Pixi. It controls plugin-owned Python workers; there is no direct-Python fallback. Keep the checkout/install directory and its Pixi environment available while the plugin runs. Do not enable unbuilt GUI entries: run `build` first. Desktop GUI contributions require a global plugin entry. The development `setup` task does **not** edit configuration; the explicit `install` task above does.

### Python only through Pixi

The guard refuses direct Python/interpreter/tool commands, including absolute `.pixi` Python paths. Projects use a locked Pixi workspace; standalone Python scripts use PEP 723 metadata and `pixi run --script`. Dependencies are declared with Pixi, not mutated through `pixi run pip install`. Other languages get a strong preference for Pixi-managed toolchains, without forced migrations.

The guard inspects native shell tool dispatch and shell creation. It rejects ambiguous shell constructs rather than silently rewriting them. It is a command-policy guard, **not an OS-wide guarantee** about arbitrary programs, remote MCP servers, editor services, or hidden subprocesses. See [coverage and examples](docs/pixi-policy.md).

### Durable pause

- **Checkpoint controls** provide stable status plus direct **Pause** and **Resume…** controls in the native composer-pill row, with a session-header fallback. Background polling does not flash the label or disable actions. Resume review uses a native dialog; Send/Stop is unchanged.
- Desktop commands/shortcuts: Pause `⌘⇧P`, Resume `⌘⇧R` (customizable in OpenCode).
- Server commands: `/enhance-pause`, `/enhance-status`, `/enhance-resume`.
- `/enhance-forget confirm` explicitly removes settled checkpoint history for the current session tree; paused or unresolved work cannot be forgotten.

The agent must save bounded origin/current/next notes before other observed tool dispatch. Tool starts/outcomes are journaled durably without storing raw arguments or results. Pause persists an ancestor gate before requesting interruption of the session tree. Ordinary messages do not unpause it. After a restart, interrupted calls become unknown—not automatically retried.

Closing the lid does **not** automatically pause a session. Use explicit Pause
and reconcile before Resume. Storage is native OpenCode plugin storage, not a
power-loss-safe external journal: an abrupt unflushed VM power cut lost a recent
Pause write. Do not infer a sudden-power-loss guarantee from restart, reboot or
VM-suspension checks.

OpenCode's lower-level shell hook has no session identity. While any checkpoint is paused or has unacknowledged uncertainty, **new shells across the shared plugin namespace are conservatively blocked**, including shells in otherwise unrelated sessions. Direct native/manual shell activity is not falsely attributed to a tool journal. This opt-in safety boundary avoids a native-shell bypass; see [checkpoint limits](docs/checkpoints.md).

Resume displays the recorded notes and operations, requires explicit reconciliation, and separately acknowledges uncertain side effects. **File changes are not automatically snapshotted or verified:** inspect the workspace/external effects before confirming; continuation instructions also require verification. The plugin cannot freeze or guarantee cancellation of arbitrary external jobs. A paused badge is not a universal “safe to close” guarantee. See [precise semantics and limits](docs/checkpoints.md) and [desktop controls](docs/desktop.md).

Checkpoints live in OpenCode's plugin storage and may contain private task summaries. Disabling/removing the plugin removes its gates; it does not reverse work or erase stored data. Evidence data remains separate.

## Try evidence search without installing the plugin

```sh
pixi run --locked search /absolute/path/to/project "where is failed work parked?"
pixi run --locked search /absolute/path/to/project "retry_delay" --mode lexical
```

Modes:

- `lexical`: transparent local BM25 baseline over extracted units.
- `semantic` (default for this opt-in tool): ColGrep semantic ranking with the pinned code encoder. Document-specific encoders are not yet integrated.
- `auto`: reciprocal-rank fusion of those two rankings. **Not** a learned claim that enhancement is better than native behavior.

Use OpenCode's native grep/glob/read for **code**, exact, exhaustive, already-located, or tiny-project tasks. The nearby-code-project evaluation did not establish an advantage over its lexical baseline. Evidence discovery is promising for documents and semantic questions, not a universal code-search upgrade. Search errors return a disclosed lexical fallback when possible; native tools are never intercepted. Empty results never prove absence.

Every hit has an `evidence` object with original relative path, source SHA-256, and original line/page/paragraph locator. Search re-reads and verifies each returned source. `open_enhance_read` refuses stale evidence rather than silently citing changed content. PDF/DOCX extraction is an interpretation layer; even verified text is not proof of factual truth.

## Opt in on a compatible OpenCode host

After setup, add a local plugin entry to the configuration you choose:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/absolute/path/to/open-enhance",
    "options": { "evidence": true }
  }]
}
```

Optional `dataDirectory` must be an absolute path matching setup's `OPEN_ENHANCE_HOME`. The plugin registers only `open_enhance_search` and `open_enhance_read`. Without `evidence: true`, it registers nothing.

The adapter obtains the **invoking session's** directory on each call. It authorizes the source inventory before extraction and refuses workspace search if applicable read-deny rules exist. This is intentionally more conservative than native narrow-file reads. It does not scan hidden files, follow source symlinks, or index known secret filenames. These safeguards are not a guarantee that arbitrary source files contain no sensitive data.

Local `.gitignore` exclusions are honored. `.ignore` and global ignore-file exclusions are not currently imported; see the [security boundaries](docs/security.md) before selecting a workspace.

Source projects are read-only: a filtered mirror is materialized under the plugin data directory before ColGrep sees it. Models, indexes, and extraction artifacts are never written into the searched project. Native tools and permissions remain intact.

OpenCode watches configuration changes; no system service restart is part of installation.

## Reproduce evaluations

```sh
pixi run --locked evaluate --repeats 2
pixi run --locked decision-evaluate --model joey
pixi run --locked decision-evaluate --model elephant
```

The last two tasks use a separate locked Pixi environment and download approximately 5 GB / 18 GB respectively. They are shadow experiments, not plugin features. Run performance evaluations serially to avoid GPU contention.

Local case files can be evaluated with `evaluate --root <absolute-folder> --cases <local-json> --output <local-report>`. Keep private cases, paths, source copies and raw results under `.local/` or configured plugin storage. Only synthetic fixtures and aggregate results belong in public reports.

Tests use synthetic sources and isolated HOME/XDG directories. SDK integration checks exercise registration, native-tool preservation, permissions and the worker, without credentials, network access, global configuration changes or paid model requests. They do not constitute a model-tool-dispatch or agent-quality evaluation.

Additional deterministic fake-SSE tests exercise real model-to-tool dispatch for the execution guard and checkpoint journal. They test integration, not model quality.
