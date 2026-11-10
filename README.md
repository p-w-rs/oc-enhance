# open-enhance

**Opt-in enhancements for OpenCode V2. Release candidate under validation—not yet approved for production release.** Native tools and permissions remain authoritative. Only explicit user Pause gates a session tree; bookkeeping and uncertainty do not lock ordinary work.

macOS Apple Silicon only (macOS 15+; fresh CLI/backend acceptance on 15.0 and 26.6.2, Desktop acceptance on 26.6.2). Pixi **0.81.0 or newer** is the only separately installed project tool, beyond macOS and the OpenCode host. Development uses a repository-owned OpenCode SDK/CLI, not the system installation.

## Status

- Implemented: shared Review-pane terminals for agents (opt-in; read, type, open), best-effort task notes, explicit pause/resume, portable project handoff export/import, desktop composer controls, scoped local evidence search over permitted sources, sandboxed native-text PDF/DOCX extraction, source hashes/citations, external indexes, bounded cancellable workers, synthetic evaluations.
- Experimental: System 1 tool-ranking **evaluation only**. It never intercepts or executes tool calls.
- Deliberately absent: shell rewriting, automatic tool hiding, prompt rewriting, general-purpose persistent agent memory, and automatic replacement of native search. Checkpoints contain bounded task summaries and observed operations, not private reasoning or full process snapshots.
- Not implemented: OCR, visual page retrieval, learned document-specific retrieval, a persistent inference service, or full end-to-end task-success evaluation.
- Technical release readiness requires current-source tests, audits, fresh guest installation, live Desktop checks, and reboot recovery. Physical sleep/wake is optional. Publication and licensing require separate authorization. See [release gates](docs/release.md), [security](docs/security.md), and [evaluation](docs/evaluation.md).

The evidence adapter requires `permission.assert` (tested with **OpenCode 2.2.6**). Unsupported hosts disable evidence only; native tools and independent checkpoint controls are not removed. Setup does not upgrade OpenCode or change global configuration.

## Setup

### Install in your own OpenCode Desktop

Requires **OpenCode V2 2.2.6+** (tested with 2.2.6), **macOS 15+ on Apple Silicon**,
and **[Pixi](https://pixi.sh) 0.81.0+**. No separate Python, Node, npm or model
service is needed. This is a release candidate; review the safety limits below.

Download this repository with **Code → Download ZIP**, extract it, open a terminal
in the extracted folder, and run:

```sh
pixi run --locked install --checkpoints --evidence
```

Add `--terminals` to share the Review-pane terminals with agents (see
[shared terminals](docs/terminals.md)).

Or, if you already have Git:

```sh
git clone https://github.com/p-w-rs/open-enhance.git
cd open-enhance
pixi run --locked install --checkpoints --evidence
```

Each flag explicitly enables that feature; use `--no-checkpoints` or `--no-evidence`
to disable an already enabled feature. Omitted options retain their prior values. Installation
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
enabled unless explicitly disabled with `--no-checkpoints`/`--no-evidence`. Recovery commands:

```sh
pixi run --locked install --rollback
pixi run --locked install --uninstall
```

Rollback requires a prior managed installation. Uninstall removes only this
plugin's config entry; snapshots, evidence data and stored checkpoints remain.
If installation reports an existing lock or incomplete snapshot, inspect the
reported path and confirm no installer is running; do not delete broad data trees.

Checkpoint notes are optional and objectives can change. Custom/read-only agents
work without the maintenance tool; installation never broadens permissions. See
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

## Checkpoints, handoffs and evidence

All features are independently opt-in:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/absolute/path/to/open-enhance",
    "options": {
      "checkpoints": true,
      "evidence": false,
      "pixiExecutable": "/absolute/path/to/pixi"
    }
  }]
}
```

`pixiExecutable` is needed when Desktop's PATH does not include Pixi. It controls plugin-owned Python workers; there is no direct-Python fallback. Keep the checkout/install directory and its Pixi environment available while the plugin runs. Do not enable unbuilt GUI entries: run `build` first. Desktop GUI contributions require a global plugin entry. The development `setup` task does **not** edit configuration; the explicit `install` task above does.

### Native tools remain native

The global shell/Python guard has been removed, not made configurable. No shell grammar policing, tool denylist or strict Python-policy instruction is injected. Existing `pixiGuard` options are ignored and removed on managed reinstall. Plugin-owned Python still uses the locked Pixi runtime; native commands follow native permissions and project instructions.

See [runtime boundaries](docs/pixi-policy.md) and the [restriction review](docs/restriction-review.md).

### Durable pause

- **Checkpoint controls** provide stable status plus direct **Pause** and **Resume…** controls in the native composer-pill row, with a session-header fallback. Background polling does not flash the label or disable actions. Resume review uses a native dialog; Send/Stop is unchanged.
- Desktop commands/shortcuts: Pause `⌘⇧P`, Resume `⌘⇧R` (customizable in OpenCode).
- Server commands: `/enhance-pause`, `/enhance-status`, `/enhance-resume`.
- `/enhance-forget confirm` removes checkpoint history for the current session tree; resume explicitly paused work first.

Notes are optional and objectives are mutable. Tool observations omit raw arguments/results; Code Mode records its outer envelope. Storage failures visibly degrade bookkeeping, not native tool access. Unknown outcomes warn without locking the session or automatically retrying anything. Explicit Pause still gates the selected session tree; ordinary messages do not silently unpause it.

Closing the lid does **not** automatically pause a session. Use explicit Pause
and reconcile before Resume. Storage is native OpenCode plugin storage, not a
power-loss-safe external journal: an abrupt unflushed VM power cut lost a recent
Pause write. Do not infer a sudden-power-loss guarantee from restart, reboot or
VM-suspension checks.

There is no cross-session checkpoint shell barrier. OpenCode's lower-level shell hook lacks session identity, so checkpoints do not gate it: unrelated sessions keep working, and direct native/manual shells remain outside checkpoint pause coverage. See [checkpoint limits](docs/checkpoints.md).

Resume displays notes and uncertainty notices and requires an explicit click, not a reconciliation essay or acknowledgment checkbox. Independently paused children stay paused. **File changes are not snapshotted or verified.** The plugin cannot freeze arbitrary external jobs; a paused badge is not a universal “safe to close” guarantee. See [semantics and limits](docs/checkpoints.md) and [desktop controls](docs/desktop.md).

Checkpoints live in OpenCode's plugin storage and may contain private task summaries. Disabling/removing the plugin removes its gates; it does not reverse work or erase stored data. Evidence data remains separate.

### Portable project handoff

Local runtime state is stored under the plugin's native `checkpoints/v1` key,
not in the project. To share a task, export notes with `open_enhance_handoff`,
save its JSON via native file tools at **`.opencode/handoffs/<task>.json`**, review
it for sensitive content and share it with the project. Another user/session can
read and import that file. No pause flags, permissions, session identity or
operations transfer, and nothing is automatically executed. See the
[handoff format and workflow](docs/checkpoints.md#share-a-task-with-another-user-or-session).

### Scoped, partial evidence coverage

`open_enhance_search` accepts a workspace-relative `scope` subdirectory. Sources
are individually authorized; native rule-denied candidates are excluded and
counted, while user rejection/feedback and cancellation still stop the request.
Oversized inventories return bounded partial coverage with `truncated: true`.
Single-token reads check only that source's native permissions.

Plugin option `evidencePolicy` supports `includeHidden`, `includeGenerated`,
`includeSensitiveNames` (all default false), plus lower `maxFiles` and
`maxSourceBytes` budgets within the 5,000-file/96-MiB ceilings. `.git`, `.local`
and `.pixi` are always excluded from evidence. These are coverage filters, not
secret scanning. Local Git exclusions remain authoritative; `.ignore` and global
ignore exclusions are not imported. Source/storage separation and no-follow
checks remain in force. Different authorized inventories/scopes use isolated
mirrors; old mirrors remain local private data until explicitly removed.

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

The adapter obtains the **invoking session's** directory on each call. It authorizes each selected source before extraction and excludes native rule-denied candidates without disabling permitted retrieval. It never follows source symlinks. Hidden/generated/sensitive-looking names are excluded by default and can be explicitly included through coverage options. No filename filter guarantees that arbitrary source files contain no sensitive data.

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
