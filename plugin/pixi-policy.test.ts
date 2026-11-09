import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { installPixiPolicy, pixiPolicyInstructions } from "./pixi-policy.js"

let root: string
let movedRoot: string
before(async () => {
  const base = path.resolve(".local/pixi-policy-tests")
  await mkdir(base, { recursive: true })
  root = await mkdtemp(path.join(base, "case-"))
  movedRoot = await mkdtemp(path.join(base, "moved-"))
  await writeFile(path.join(movedRoot, "pixi.toml"), '[workspace]\nname = "moved"\n')
  await writeFile(path.join(movedRoot, "pixi.lock"), "version: 6\n")
  await mkdir(path.join(movedRoot, "child"))
  await writeFile(path.join(movedRoot, "script.py"), '# /// script\n# dependencies = []\n# ///\nprint("moved synthetic")\n')
  for (const name of ["extensionless", "pixi", "sh"]) {
    await writeFile(path.join(movedRoot, name), '#!/usr/bin/env python3\nraise RuntimeError("must never execute")\n')
  }
  await writeFile(path.join(movedRoot, "native"), '#!/bin/sh\necho synthetic\n')
  await symlink(path.join(movedRoot, "extensionless"), path.join(root, "external-link"))
  await writeFile(path.join(root, "pixi.toml"), '[workspace]\nname = "synthetic"\n')
  await writeFile(path.join(root, "pixi.lock"), "version: 6\n")
  await mkdir(path.join(root, "child"))
  await writeFile(path.join(root, "child", "pyproject.toml"), '[project]\nname = "not-pixi-child"\n')
  await mkdir(path.join(root, "other"))
  await writeFile(path.join(root, "other", "pyproject.toml"), '[tool.pixi.workspace]\nname = "other"\n')
  await writeFile(path.join(root, "other", "pixi.lock"), "version: 6\n")
  await writeFile(path.join(root, "script.py"), '# /// script\n# requires-python = ">=3.12"\n# dependencies = []\n# ///\nprint("synthetic")\n')
  await writeFile(path.join(root, "plain.py"), 'print("synthetic")\n')
  await writeFile(path.join(root, "shebang"), '#!/usr/bin/env -S python3 -I\nprint("synthetic")\n')
  await writeFile(path.join(root, "native"), '#!/bin/sh\necho synthetic\n')
  await symlink("/usr/bin", path.join(root, "outside"))
})
after(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  if (movedRoot) await rm(movedRoot, { recursive: true, force: true })
})

type Callback = (value: any) => Promise<void> | void
async function harness(options: Record<string, unknown> = { pixiGuard: true }, failDomain?: string, disposed: string[] = []) {
  const hooks = new Map<string, Callback>()
  let sessionRoot = root
  const reads: any[] = [], deniedReads = new Set<string>()
  const register = (domain: string) => async (name: string, callback: Callback) => {
    if (domain === failDomain) throw new Error("synthetic registration failure")
    hooks.set(`${domain}.${name}`, callback)
    return { dispose: async () => { disposed.push(`${domain}.${name}`) } }
  }
  const context = {
    options, location: { directory: root },
    shell: { hook: register("shell") },
    tool: { hook: register("tool") },
    session: { hook: register("session"), get: async () => ({ location: { directory: sessionRoot } }) },
    permission: { assert: async (input: any) => {
      reads.push(input)
      if (input.resources.some((file: string) => deniedReads.has(file))) throw new Error("synthetic native read denied")
    } },
  } as unknown as Plugin.Context
  const cleanup = await installPixiPolicy(context)
  return {
    hooks, disposed, cleanup, reads, deniedReads, context,
    setSessionRoot: (directory: string) => { sessionRoot = directory },
    shell: async (command: string, cwd = root) => hooks.get("shell.create.before")!({ command, cwd }),
    tool: async (command: string, workdir?: string) => hooks.get("tool.execute.before")!({ tool: "shell", sessionID: "synthetic", agent: "agent-synthetic", messageID: "message-synthetic", id: "call-synthetic", input: { command, ...(workdir ? { workdir } : {}) } }),
  }
}

test("disabled unless explicitly true, including truthy strings", async () => {
  for (const option of [undefined, false, "true", 1]) {
    const guard = await harness({ pixiGuard: option })
    assert.equal(guard.hooks.size, 0)
    assert.equal(guard.cleanup, undefined)
  }
})

test("installs actual V2 hooks and appends instructions without rewriting messages", async () => {
  const guard = await harness()
  assert.equal(guard.hooks.size, 3)
  const input = { system: [{ type: "text", text: "original" }], messages: [{ content: "original" }] }
  await guard.hooks.get("session.context")!(input)
  assert.equal(input.system[0].text, "original")
  assert.equal(input.system[1].text, pixiPolicyInstructions)
  assert.deepEqual(input.messages, [{ content: "original" }])
  await guard.cleanup!()
  assert.equal(guard.disposed.length, 3)
})

test("rolls back registrations on partial installation failure", async () => {
  const disposed: string[] = []
  await assert.rejects(() => harness({ pixiGuard: true }, "session", disposed), /synthetic registration failure/)
  assert.deepEqual(disposed, ["shell.create.before", "tool.execute.before"])
})

test("allows ordinary native commands, literals, compounds and locked Pixi tasks", async () => {
  const guard = await harness()
  for (const command of [
    "git status --short", "ls -la | head -n 4", "echo python; pwd", "false || echo fine",
    "printf '%s' '$(python evil.py)'", 'echo "literal python3"', "echo '\\`python\\`'",
    "find . -name '*.py'", "node --version", "npm run check", "/bin/echo python", 'echo "$HOME"',
    "pixi --version", "pixi --help", "pixi run --locked test", "pixi run --locked python -m pytest",
    "pixi run --locked --offline python -m pytest", "pixi --offline run --locked test",
    "pixi run --locked pytest", "pixi run --locked ruff check .", "pixi run --locked ./plain.py",
    "pixi run --locked sh -c 'python -m pytest && ruff check .'",
    "env FOO=bar pixi run --locked test", "command pixi run --locked test",
    "exec pixi run --locked test", "sudo -n pixi run --locked test", "time -p pixi run --locked test",
    "pixi run --locked --manifest-path other/pyproject.toml test",
    "pixi --manifest-path=other/pyproject.toml run --locked test",
    "cd child && pixi run --locked test", "pixi run --script script.py", "./native",
    "sh -lc 'pixi run --locked test'", "echo ok # python\npixi run --locked test",
  ]) {
    await assert.doesNotReject(() => guard.tool(command), command)
    await assert.doesNotReject(() => guard.shell(command), command)
  }
})

test("blocks Python tools, absolute paths, quoting and wrapper evasions on both surfaces", async () => {
  const guard = await harness()
  for (const command of [
    "python --version", "python3.13 -c pass", "pypy3 script.py", "pip install x", "uv run python",
    "pytest", "ruff check .", "mypy .", "poetry run pytest", "conda run python", "pixi shell",
    "/usr/bin/python3 -c pass", ".pixi/envs/default/bin/python script.py", "./script.py", "./shebang",
    '"py"thon -c pass', "py\\thon -c pass", "py\\\nthon -c pass", "'python3' -m pip",
    "echo ok && python", "echo ok; python", "echo ok | python", "false || python", "! python",
    "env FOO=bar python", "env -i python", "command -- python", "exec python", "sudo -n python",
    "time python", "nohup python", "nice python", "builtin command python", "sh -c 'python -c pass'",
    "noglob python", "nocorrect python", "arch -arm64 python", "- python", "=python",
    "nice -n 5 python", "sudo -p prompt python", "timeout 5 python", "timeout -- 5 python",
    'bash -lc "env python"', "sh script.sh", "sh -s", "env -S 'python -c pass'",
    "pixi run python", "pixi run --frozen python", "pixi run --locked pip install x",
    "pixi run --locked python -m pip install x", "pixi run --locked python -mpip install x",
    "pixi run --locked python -Im pip install x", "pixi run --locked pypy3 -m virtualenv v",
    "pixi run --locked python -m pip.__main__ install x", "pixi run --locked python -m ensurepip",
    "pixi run --locked python -m venv v", "uvicorn app:app", "pre-commit run",
    "pixi run --locked uv run python", "pixi run --locked poetry install", "pixi run --locked conda create x",
    "pixi run --locked sh -c 'pip install x'", "pixi run --script plain.py",
  ]) {
    await assert.rejects(() => guard.shell(command), /open-enhance Pixi policy:/, command)
    await assert.rejects(() => guard.tool(command), /open-enhance Pixi policy:/, command)
  }
})

test("rejects ambiguous executable syntax rather than silently rewriting", async () => {
  const guard = await harness()
  for (const command of [
    "echo $(python -c pass)", 'echo "$(python -c pass)"', "echo `python -c pass`",
    "echo <(python)", "python <<'PY'\npass\nPY", "cat <<'SH'\npython\nSH",
    "$(printf python) -c pass", "$PYTHON -c pass", "${PYTHON} -c pass", "py* -c pass",
    "$'python' -c pass", "eval 'python'", ". script.sh", "source script.sh",
    "alias py=python; py", "export BASH_ENV=evil; bash -c true", "trap python EXIT",
    "for x in python; do $x; done", "(python)", "f() { python; }; f", "echo ok & python",
    "find . -exec python {} \\;", "printf python | xargs", "echo > file", "'unterminated",
    "pixi run --locked $TASK", "pixi run --locked env PATH=/evil python", "PATH=/evil pixi run --locked test",
  ]) await assert.rejects(() => guard.shell(command), /open-enhance Pixi policy:/, command)
  const input = { command: "python -c pass", cwd: root }
  await assert.rejects(async () => guard.hooks.get("shell.create.before")!(input))
  assert.equal(input.command, "python -c pass")
})

test("validates manifests, lock files, cwd changes, and workspace boundaries", async () => {
  const guard = await harness()
  await assert.doesNotReject(() => guard.tool("pixi run --locked test", path.join(root, "child")))
  for (const command of [
    "cd child; pixi run --locked test", "false || cd child && pixi run --locked test",
    "cd child && true || pixi run --locked test", "cd child | pixi run --locked test",
    "cd missing && pixi run --locked test", "cd outside && pixi run --locked test",
    "pixi run --locked --manifest-path absent.toml test",
    "pixi run --locked --manifest-path outside/pixi.toml test",
    "pixi run --script outside/evil.py", "pixi run --script --manifest-path pixi.toml script.py",
  ]) await assert.rejects(() => guard.shell(command), /open-enhance Pixi policy:/, command)
  await assert.rejects(() => guard.shell("pixi run --locked test", "/"), /workspace/)
  await mkdir(path.join(root, "unlocked"))
  await writeFile(path.join(root, "unlocked", "pixi.toml"), '[workspace]\nname = "unlocked"\n')
  await assert.rejects(() => guard.shell("pixi run --locked --manifest-path unlocked/pixi.toml test"), /does not exist/)
  await writeFile(path.join(root, "unlocked", "pyproject.toml"), '[project]\nname = "not-pixi"\n')
  await assert.rejects(() => guard.tool("pixi run --locked --manifest-path unlocked/pyproject.toml test"), /no Pixi configuration/)
})

test("allows authorized Pixi environment and script preparation without requiring existing inputs", async () => {
  const guard = await harness()
  const empty = path.join(root, "empty")
  await mkdir(empty)
  for (const command of [
    "pixi init", "pixi init new-workspace", "pixi init --script new-script.py",
    "pixi init --script plain.py", "pixi add python", "pixi add --pypi requests",
    "pixi add --script new-script.py requests", "pixi add --script plain.py requests",
    "pixi remove --script plain.py requests", "pixi remove requests", "pixi lock", "pixi install",
    "pixi install --locked", "pixi version", "pixi help", "pixi help run", "pixi --version", "pixi --help",
    "pixi --manifest-path new/pixi.toml add python", "pixi add python && pixi lock",
  ]) {
    await assert.doesNotReject(() => guard.tool(command, empty), command)
    await assert.doesNotReject(() => guard.shell(command, empty), command)
  }
  assert.equal(guard.reads.length, 0, "management relies on Pixi and native execution permissions, not source reads")
  for (const command of [
    "pixi exec python", "pixi shell", "pixi shell-hook", "pixi completion", "pixi config set x y",
    "pixi auth login", "pixi global install python", "pixi self-update", "pixi add $(python)",
    "pixi --config evil add python", "pixi $VERB python", "pixi add python; python --version",
  ]) {
    await assert.rejects(() => guard.tool(command, empty), /open-enhance Pixi policy:/, command)
    await assert.rejects(() => guard.shell(command, empty), /open-enhance Pixi policy:/, command)
  }
})

test("uses moved session roots and keeps policy active for sessionless or explicit external cwd", async () => {
  const guard = await harness()
  guard.setSessionRoot(movedRoot)
  await guard.tool("pixi run --locked python -m pytest")
  await guard.shell("pixi run --locked python -m pytest", movedRoot)
  await guard.tool("pixi run --locked test", "child")
  await guard.shell("pixi run --locked test", path.join(movedRoot, "child"))
  await guard.tool("pixi run --script script.py")
  await guard.shell("pixi run --script script.py", movedRoot)
  // No attributed proof: the external cwd is still inspected with its own boundary.
  await guard.shell("pixi run --locked pytest", movedRoot)
  await guard.shell("pixi add python", movedRoot)
  for (const command of ["python", "pip install requests", "pixi run --locked pip install requests", "pixi exec python"]) {
    await assert.rejects(() => guard.tool(command), /open-enhance Pixi policy:/)
    await assert.rejects(() => guard.shell(command, movedRoot), /open-enhance Pixi policy:/)
  }
  guard.setSessionRoot(root)
  await guard.tool("pixi run --locked pytest", movedRoot)
  await assert.rejects(() => guard.tool("python", movedRoot), /direct Python/)
})

test("native workdir authorizes selected sources and hands proof only to the matching shell cwd", async () => {
  const guard = await harness()
  const file = path.join(movedRoot, "script.py")
  guard.deniedReads.add(file)
  await assert.rejects(() => guard.tool("pixi run --script script.py", movedRoot), /synthetic native read denied/)
  assert.deepEqual(guard.reads.at(-1).resources, [file])
  guard.deniedReads.delete(file)
  await guard.tool("pixi run --script script.py", movedRoot)
  await assert.rejects(() => guard.shell("pixi run --script script.py", root), /attributed native shell tool/)
  await guard.shell("pixi run --script script.py", movedRoot)
  await assert.rejects(() => guard.shell("pixi run --script script.py", movedRoot), /attributed native shell tool/)
  await assert.rejects(() => guard.tool("python", movedRoot), /direct Python/)
})

test("source reads require exact native read attribution and denials propagate", async () => {
  const guard = await harness()
  const file = path.join(root, "script.py")
  guard.deniedReads.add(file)
  await assert.rejects(() => guard.tool("pixi run --script script.py"), /synthetic native read denied/)
  assert.deepEqual(guard.reads[0], {
    sessionID: "synthetic", agent: "agent-synthetic",
    source: { type: "tool", messageID: "message-synthetic", id: "call-synthetic" },
    action: "read", resources: [file], save: [file],
  })
  await assert.rejects(() => guard.shell("pixi run --script script.py"), /attributed native shell tool/)
  guard.deniedReads.delete(file)
  await guard.tool("pixi run --script script.py")
  const count = guard.reads.length
  await guard.shell("pixi run --script script.py")
  assert.equal(guard.reads.length, count, "sessionless hook never reads source contents")
  await assert.rejects(() => guard.shell("pixi run --script script.py"), /attributed native shell tool/, "validation is consumed once")
  guard.deniedReads.add(path.join(root, "native"))
  await assert.rejects(() => guard.tool("./native"), /synthetic native read denied/)
  guard.deniedReads.add(path.join(root, "other", "pyproject.toml"))
  await assert.rejects(() => guard.tool("pixi run --locked --manifest-path other/pyproject.toml test"), /synthetic native read denied/)
  await assert.rejects(() => guard.shell("./native"), /attributed native shell tool/)
})

test("source-validation handoff is exact, expires, and never substitutes for a missing permission API", async () => {
  const guard = await harness()
  await guard.tool("pixi run --script script.py")
  await assert.rejects(() => guard.shell("pixi run --script script.py extra"), /attributed native shell tool/)
  const original = Date.now
  try {
    Date.now = () => original() + 31000
    await assert.rejects(() => guard.shell("pixi run --script script.py"), /attributed native shell tool/)
  } finally { Date.now = original }
  Object.defineProperty(guard.context.permission, "assert", { value: undefined })
  await assert.rejects(() => guard.tool("pixi run --script script.py"), /lacks permission.assert/)
  await assert.rejects(() => guard.tool("./native"), /lacks permission.assert/)
  await assert.doesNotReject(() => guard.tool("pixi add python"), "metadata-only management does not need source-read API")
})

test("explicit external executable paths cannot bypass shebang checks or native read permission", async () => {
  const guard = await harness()
  for (const command of [
    path.join(movedRoot, "extensionless"),
    path.relative(root, path.join(movedRoot, "extensionless")),
    "./external-link",
    `${path.join(movedRoot, "pixi")} run --locked test`,
    `${path.join(movedRoot, "sh")} -c 'echo harmless'`,
  ]) {
    await assert.rejects(() => guard.shell(command), /attributed native shell tool/, command)
    await assert.rejects(() => guard.tool(command), /direct Python shebang/, command)
  }
  const external = path.join(movedRoot, "native")
  guard.deniedReads.add(external)
  await assert.rejects(() => guard.tool(external), /synthetic native read denied/)
  assert.deepEqual(guard.reads.at(-1).resources, [external])
  assert.equal(guard.reads.at(-1).source.id, "call-synthetic")
  guard.deniedReads.delete(external)
  await guard.tool(external)
  await guard.shell(external)
  await assert.rejects(() => guard.shell(external), /attributed native shell tool/)
  await assert.doesNotReject(() => guard.shell("/bin/echo harmless"), "standard OS executable metadata exception")
  guard.deniedReads.add(await realpath("/bin/echo"))
  await assert.rejects(() => guard.tool("/bin/echo harmless"), /synthetic native read denied/, "attributed tool paths always request read permission, including OS binaries")
})

test("ignores non-shell tools and fails closed for malformed shell inputs", async () => {
  const guard = await harness()
  const callback = guard.hooks.get("tool.execute.before")!
  await callback({ tool: "read", input: { command: "python" } })
  for (const input of [null, "python", {}, { command: 42 }, { command: "pwd", workdir: 42 }]) {
    await assert.rejects(async () => callback({ tool: "shell", input }), /open-enhance Pixi policy:/)
  }
})
