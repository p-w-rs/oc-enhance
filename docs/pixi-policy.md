# Python through Pixi (opt-in)

Set the plugin option `pixiGuard` to the boolean `true`. It is independent of
evidence retrieval and disabled by default. No exceptions are inferred from user
messages, model output, or truthy strings.

The installer registers the installed OpenCode V2 API's `shell.create.before`,
`tool.execute.before` (only the native `shell` tool), and `session.context` hooks.
Rejected commands throw an actionable error. The original command, native tools,
permissions, and user prompts are unchanged. Agent context receives an additional
system instruction: Python must use Pixi; other languages should prefer existing
Pixi tooling where practical, without forced migration or dependency changes.

## Integration

```ts
import { installPixiPolicy } from "./pixi-policy.js"

// In Plugin.define({ async setup(ctx) { ... } }), BEFORE any evidence-only return:
const disposePixiPolicy = await installPixiPolicy(ctx)
// Compose with the plugin's existing cleanup; do not discard either cleanup.
// On later setup failure, also dispose any registrations already installed.
```

Exact export: `installPixiPolicy(ctx: Plugin.Context): Promise<Plugin.Cleanup | void>`
using `import type { Plugin } from "@opencode/plugin"` (tested with 2.2.6).
When enabled, the return value disposes all three registrations. Partial installer
failure rolls back registrations it already created.

## Accepted command forms

- Ordinary explicit native commands: `git status`, `npm run check`,
  `find . -name '*.py'`, pipelines, `;`, `&&`, and `||`.
- Explicit Pixi management verbs `init`, `add`, `remove`, `lock`, `install`,
  `version`, and `help` are allowed. They do **not** require a pre-existing
  manifest, lock, or script metadata. For example, an authorized Python workflow
  can use `pixi init`, `pixi add python`, then `pixi run --locked python`.
  Standalone workflows can use `pixi init --script new.py` or
  `pixi add --script plain.py requests` before running the script. Pixi validates
  the command's options and operands. Allowing a verb is not authorization:
  the user's task and native execution permissions still govern changes.
  `exec`, `shell`, `shell-hook`, `global`, `config`, `auth`, `completion`, and
  unknown verbs remain rejected; management commands cannot smuggle a subsequent
  direct Python command past inspection.
- `pixi run --locked test`, `pixi run --locked python -m pytest`, and
  `pixi run --locked ruff check .` use an **existing** workspace manifest and
  **existing** sibling `pixi.lock`. Lock freshness and TOML correctness remain
  Pixi's responsibility. `--frozen` is not a substitute for `--locked` here.
  `--offline` is supported, for example `pixi run --locked --offline test`.
- `--manifest-path` / `-m` select an existing `pixi.toml` or Pixi-enabled
  `pyproject.toml`. The tool hook derives its root from the **current session
  location on every invocation**, including moved sessions. Discovery searches
  cwd ancestors up to that root. The model-facing native shell tool selects cwd
  with its `workdir` input; the lower-level `shell.create.before` hook exposes
  the resolved directory as `cwd`. An explicit cwd outside that root receives its
  own boundary, not an exemption. The sessionless shell hook uses the plugin root
  for descendant cwd values and otherwise the command's real cwd. An immediately
  preceding matching tool check supplies its session boundary. For runs, selected manifest,
  lock and script real paths must stay inside the applicable boundary.
- `pixi run --script script.py` requires a local regular file with a closed
  comment-form PEP 723 `# /// script` block within the first 64 KiB. Pixi validates
  the metadata TOML; the tool guard only recognizes the block after native read
  permission is granted for the exact script. Standalone scripts may
  resolve/install their declared dependencies using Pixi's script mechanism;
  unlike workspace runs, they do not require an existing workspace lockfile.
  A sessionless `shell.create` invocation cannot independently inspect source:
  use the attributed native shell tool for this form.
- Common `env`, `command`, `exec`, `sudo`, `time`, `builtin`, `nice`, `nohup`,
  `timeout`, `caffeinate`, `arch`, and zsh `noglob`/`nocorrect` wrappers are unwrapped when their limited supported
  options leave a visible command. A shell wrapper must have one literal `-c`
  argument. Unsupported wrapper options fail closed.
- A simple `cd child && command` tracks the new cwd, including manifest discovery.
  Use the native shell tool's `workdir` input for more complex working-directory requirements.

Direct Python interpreters, Python scripts (including absolute `.pixi` paths),
common Python tooling, and directly named local Python-shebang scripts are
rejected outside Pixi. Visible package-manager commands inside Pixi are rejected
except standalone help/version requests; package-manager Python modules such as
`python -m pip` are also rejected. Declare authorized environment changes through
the allowed Pixi management commands, rather than ad hoc package-manager commands
inside a Pixi environment. A normal user task can authorize that preparation;
the policy does not demand a special exception or force an already-existing setup.

## Conservative rejections

This dependency-free lexer supports shell words, ordinary single/double quoting,
escaping and command lists. It rejects command/process substitutions and backticks
(including inside double quotes), executable variable/glob expansion, ANSI shell
quotes, heredocs, redirections, grouping, loops/functions, shell-state mutation,
`eval`/`source`, opaque dispatchers such as `xargs`, and `find` execution actions.
Literal substitution text inside a single-quoted ordinary argument is allowed.
Dynamic Pixi arguments and unsupported Pixi options fail closed. Cwd changes in
pipelines, background/conditional branches, or nested managed shell commands are
rejected rather than guessed. Errors never silently rewrite the input.

## Security limits

**This is a visible-command policy, not a process sandbox or security boundary.**
It does not inspect arbitrary programs, imported modules, task bodies, nested
script source, package hooks, shell startup files, executables resolved through
PATH, aliases/functions installed outside the inspected command, or indirect
execution by another runtime. For example, a Node program, native binary, existing
Pixi task, or Python `-c` program can spawn processes or mutate environments; that
behavior is not recursively analyzed. With native read permission, the tool hook
reads only the first 512 bytes of directly named executables to recognize Python
shebangs, including absolute or relative paths **outside** the workspace and
symlink targets. Those explicit external paths are not forbidden merely for
being external: the exact resolved target requires attributed native read
permission. This check occurs before basename-based wrapper/Pixi handling, so an
external Python script named `sh` or `pixi` is not exempt. It does not recursively
audit scripts or inspect executables implicitly resolved through PATH.

A sessionless invocation of an explicit executable is conservatively rejected
unless its exact command/cwd was just validated by the attributed tool hook. The
only metadata-only exception is a canonical regular executable directly in
`/bin`, `/usr/bin`, `/sbin`, or `/usr/sbin`, owned by root with no group/other write
bits. These are trusted macOS OS executable directories; symlinks resolving into
user directories do not qualify. Direct Python/tool names and resolved Python
targets remain rejected. Attributed tool calls still request read permission even
for OS executables. Other local/external native binaries need the native shell
tool or Pixi. This is not a portable immutable-file guarantee outside the target
macOS trust model, nor a defense against a compromised OS/root account.

The executable-name denylist is not an exhaustive inventory of the Python
ecosystem. A renamed interpreter or an unknown console entrypoint cannot reliably
be identified by syntax alone. `pixi` is trusted to resolve to the intended binary.
Host-provided shell startup/environment state and workspace manifests/tasks must
be trusted. Native permissions remain the actual authorization mechanism; neither
passing this guard nor receiving its context instruction grants permission.

Filesystem metadata checks (`realpath` and regular-file `stat`) do not read source
contents. They select manifests and require a sibling lockfile. Pixi itself
validates manifest and lock contents. The tool hook uses `ctx.permission.assert`
with the exact resolved path, session, agent, tool call ID, and message ID before
reading a `pyproject.toml`, standalone script metadata, or explicitly named executable
header. Denials propagate unchanged, never falling back to an unpermissioned
read. Hosts without this API fail closed when source inspection is necessary.
There are no source-content reads in the sessionless shell hook: for
`pyproject.toml`, its metadata-only selection leaves Pixi configuration validation
to Pixi itself.

A successful tool check leaves a bounded, in-memory, one-use validation record
for its exact command and canonical cwd, expiring after 30 seconds. The shell hook
consumes it to avoid repeating source inspection without session attribution and
to retain the checked session boundary and selected manifest paths (including
skipping non-Pixi child `pyproject.toml` files). This is **not** cached read permission:
it cannot cause another file read, alter execution permissions, or authorize a
different command/cwd. Other source-dependent shell-only commands fail closed.
Records are cleared on plugin disposal and never written to disk.

Symlink checks reduce accidental workspace
escape but are not an atomic filesystem snapshot: files can change between
inspection and execution. Hooks cannot constrain child processes or later tool
input mutations by other plugins. Use an OS/process sandbox when those guarantees
are required. Avoid claiming that this guard prevents all Python execution or all
environment mutation.

## Validation

```sh
pixi run --locked npm run check
pixi run --locked node --import tsx --test plugin/pixi-policy.test.ts
```

Tests use synthetic manifests and script headers in temporary `.local/` test
directories, never evaluation projects. They exercise both native hook surfaces,
wrappers, quoting, compounds, substitutions, heredocs, shebangs, mutation attempts,
standalone metadata, manifest/lock selection, cwd ambiguity and opt-in behavior.
They also cover setup from missing manifests/metadata, management-verb rejection,
moved sessions, external cwd enforcement, exact read attribution, denied reads,
and one-use source-validation handoff between hooks.
External extensionless Python shebangs (absolute, relative, symlinked, and disguised
as wrappers) are rejected without executing them; OS-path read denials and offline
runs are covered too.
