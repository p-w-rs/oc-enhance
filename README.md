# oc-enhance

Small additions that make OpenCode agents more capable, without changing how OpenCode itself works. OpenCode's own
tools are never replaced, blocked or slowed down; each feature can be turned off in **Settings → Enhance**.
macOS and Linux; OpenCode 2.2.6+ and Pixi.

| Feature | What it adds |
|---|---|
| **Task notes, Pause and Resume** | Agents keep short notes (goal, done so far, next step, decisions, files) that they see on every turn. **Pause** above the message box stops the agent and its subagents and keeps them stopped; **Resume** continues from the notes. Notes survive restarts and can be handed to a colleague as a file. |
| **Documents** | `read_document`: Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and PDF as text, by paragraph range, sheet, slide or page. OpenCode's own reader handles text, code, images and PDFs, but not Office files. |
| **Project search** | `search_project`: find where something is described or implemented when you don't know the exact words, across code and documents; one passage per file with its location. Keyword ranking works out of the box; meaning-based ranking after a one-time download. |
| **Shared terminals** | `terminal_list`, `terminal_read`, `terminal_write`, `terminal_open`: agents use the terminals in the Review pane with you (Desktop). See [shared terminals](docs/terminals.md). |
| **Machine-learning know-how** | Skills agents load only when a task needs them: `ml-training` (CUDA and ROCm PyTorch environments in Pixi, MLflow tracking, long runs on GPU machines), `ml-deploy` (TensorRT 11 and Jetson: export, ModelOpt quantization, custom TensorRT plugins for new layers, running branches in parallel, a training-to-device optimization checklist) and `gpu-kernels` (Triton, CUDA/HIP, PyTorch custom ops, profiling). They make agents check installed versions and current docs before writing code. |
| **Pixi know-how** | A `pixi` skill and a one-line reminder: Python only through Pixi (`pixi run --script` for single files, a Pixi workspace for projects), Pixi-managed toolchains preferred for other languages. Guidance only; nothing is blocked. |

## Install

Requires [OpenCode](https://opencode.ai) 2.2.6+ (CLI or Desktop) and [Pixi](https://pixi.sh); macOS or Linux.

```sh
git clone https://github.com/p-w-rs/oc-enhance.git && cd oc-enhance
pixi run --locked install          # runs the tests, then installs a verified snapshot into your OpenCode config
```

Restart OpenCode (or `/reload`). Everything is on by default; open **Settings → Enhance** to turn features off or to
download meaning-based search. Installing over the earlier `open-enhance` replaces its config entry (its old options
and its `open_enhance_*` permission rules are removed).

```sh
pixi run --locked install-status   # what is installed, and whether its files are intact
pixi run --locked rollback         # back to the previous snapshot
pixi run --locked uninstall        # removes only this plugin's entry; settings and indexes stay
pixi run --locked doctor           # checks this computer
```

Updating: `git pull && pixi run --locked install`. Settings, indexes and the search engine live in
`~/.local/share/oc-enhance` (or `$XDG_DATA_HOME/oc-enhance`); task notes live in OpenCode's own plugin storage.

## Task notes, Pause and Resume

- Agents call `save_task_notes` when they start multi-step work and after milestones. Until they do, the user's first
  request is kept as the goal. The notes go into the model's context on every turn, so after a pause, a restart, a
  compaction or a long break the agent knows what it was doing.
- **Pause** (above the message box, `/pause`, or ⌘⇧P) interrupts the session and its subagents and holds them: no new
  tool calls or model requests until you **Resume** (the same button, `/resume`, ⌘⇧R) or send a new message. Resume
  asks the agent to check the notes and the files first, because interrupted work may be incomplete. Other sessions
  are never affected; your own terminal commands are not paused.
- **Handoffs**: `task_handoff export` writes the notes to `.opencode/handoffs/<name>.md` in the project. Commit it;
  a colleague with oc-enhance continues with "continue the handoff in .opencode/handoffs/<name>.md" (or
  `task_handoff import`), and anyone can simply read it. Handoffs are summaries, not instructions to execute.

## Documents

`read_document` reads the text layer: paragraphs and footnotes (Word), sheets with cell values and row numbers
(Excel), slides with speaker notes (PowerPoint), pages (PDF). Use `part` for large files (`"3"`, `"2-5"`, a sheet
name); long output says where to continue. Scanned pages without text are reported, not guessed (no OCR). Files are
parsed in a separate worker thread with size, time and memory limits. OpenCode's read permissions apply.

## Project search

- `search_project` indexes the session's project (code, notes, configs, Word/Excel/PowerPoint/PDF), honoring
  `.gitignore` and skipping hidden files, dependency and build folders, binaries and secret-looking names. Only changed
  files are re-read. Indexes are stored in oc-enhance's data folder, **never in your project**; clear them in Settings.
- Results the agent may not read (OpenCode's read permissions) are hidden. Results are ranked, not exhaustive:
  agents still use `grep` for exact strings and every occurrence.
- **Meaning-based ranking** finds passages by what they mean ("what if my flight is cancelled" finds a travel policy
  that never says "if"). It needs a one-time download of about 290 MB: [ColGrep](https://github.com/lightonai/next-plaid)
  by LightOn (Apache-2.0), [ONNX Runtime](https://onnxruntime.ai) by Microsoft (MIT) and the
  [LateOn-Code-edge](https://huggingface.co/lightonai/LateOn-Code-edge) model (Apache-2.0). Every file is checked
  against a pinned SHA-256. Use **Settings → Enhance → Download**, or `pixi run setup-search --user`. Available for
  macOS (Apple Silicon and Intel) and Linux (x64 and arm64, glibc). Without it, keyword ranking (BM25) is used.

## Development

```sh
pixi run --locked test             # type check, unit tests, real-terminal tests, installer test
pixi run --locked setup-search     # download the search engine into .local/search (enables its tests)
pixi run --locked smoke-host       # end to end on the real OpenCode CLI with a scripted model
pixi run --locked smoke-snapshot   # the same, from an installed snapshot
pixi run --locked install-dev      # point your OpenCode config at this checkout
pixi run desktop-dev start         # macOS: the installed Desktop app with an isolated profile loading this checkout
```

Layout: `plugin/index.ts` (server plugin), `plugin/gui.tsx` (Pause pill, commands, Settings page, terminal relay),
`plugin/notes.ts`, `plugin/documents.ts` + `plugin/doc-worker.mjs`, `plugin/search.ts` + `plugin/backend.ts`,
`plugin/terminal*.ts`, `skill/pixi/SKILL.md`, `scripts/` (installer, doctor, smoke test).

### History

Versions before 1.0 were called `open-enhance` (macOS only, Python worker). 1.0 is a rewrite in TypeScript: it runs
on macOS and Linux, needs nothing but Pixi, and drops the experiments that did not help (a Python-blocking shell
guard, a fast local "System 1" tool-picking model, and always-on operation journaling).
