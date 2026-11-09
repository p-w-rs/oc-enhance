import type { Plugin } from "@opencode/plugin"
import { constants } from "node:fs"
import { open, realpath, stat } from "node:fs/promises"
import path from "node:path"

const prefix = "open-enhance Pixi policy: "
function deny(reason: string): never {
  throw new Error(`${prefix}${reason}. Use Pixi management commands to prepare an authorized workspace/script, then pixi run --locked (or run --script); commands are never rewritten.`)
}

type Word = { text: string; dynamic: boolean }
type Token = Word | string
type SourceChecks = {
  read?: (file: string, size: number) => Promise<string>
  validated?: boolean
  manifests?: Map<string, string>
}
const isWord = (token: Token): token is Word => typeof token !== "string"

// A deliberately bounded shell subset, not a shell interpreter. Unsupported
// executable syntax fails closed instead of guessing how a shell evaluates it.
function lex(command: string): Token[] {
  if (command.length > 131072) deny("command exceeds inspection limit")
  const tokens: Token[] = []
  let text = "", dynamic = false, started = false, quote = ""
  const flush = () => {
    if (started) tokens.push({ text, dynamic })
    text = ""; dynamic = false; started = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i], next = command[i + 1]
    if (quote === "'") {
      if (c === "'") quote = ""
      else text += c
      continue
    }
    if (c === "`" || (c === "$" && next === "(")) deny("command/process substitution is not inspectable")
    if (c === "\\") {
      if (next === undefined) deny("unfinished escape")
      if (next === "\n") { i++; continue }
      // In double quotes only these characters are shell-escaped.
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) text += c
      else { text += next; i++; started = true; continue }
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = ""
      else { text += c; if (c === "$") dynamic = true }
      continue
    }
    if (c === "$" && (next === "'" || next === '"')) deny("ANSI/localized shell quoting is not supported")
    if (c === "'" || c === '"') { quote = c; started = true; continue }
    if (c === "#" && !started) {
      while (i < command.length && command[i] !== "\n") i++
      flush(); tokens.push(";"); continue
    }
    if (c === "\n" || /\s/.test(c)) { flush(); if (c === "\n") tokens.push(";"); continue }
    if (";&|<>()[{}".includes(c)) {
      flush()
      if ("<>()[{}".includes(c)) deny("redirections, heredocs, grouping and shell control syntax are not supported")
      if (next === c && (c === "&" || c === "|")) { tokens.push(c + c); i++ }
      else tokens.push(c)
      continue
    }
    started = true; text += c
    if ("$*?~".includes(c)) dynamic = true
  }
  if (quote) deny("unterminated shell quote")
  flush()
  return tokens
}

const pythonTool = /^(?:python(?:w|\d+(?:\.\d+)*)?|pypy\d*|pip\d*(?:\.\d+)*|pipx|uv|uvx|poetry|pdm|hatch|hatchling|conda|mamba|micromamba|virtualenv|venv|pyenv|pytest|py\.test|ruff|mypy|dmypy|black|isort|flake8|pylint|tox|nox|coverage|ipython\d*|jupyter(?:-.*)?|easy_install(?:-.*)?|pip-compile|pip-sync|twine|rye|uvicorn|gunicorn|django-admin|flask|fastapi|streamlit|scrapy|sphinx-build|mkdocs|pre-commit|cookiecutter|semgrep|ansible(?:-.*)?|airflow|celery|alembic)$/i
const shells = /^(?:ba|z|da|k)?sh$|^fish$/
const opaque = new Set(["!", "eval", "source", ".", "alias", "unalias", "function", "if", "then", "else", "elif", "fi", "for", "while", "until", "case", "do", "done", "select", "repeat", "coproc", "xargs", "parallel", "watch", "export", "unset", "set", "shopt", "enable", "hash", "typeset", "declare", "local", "readonly", "trap", "fc", "autoload"])
const packageManager = /^(?:pip\d*(?:\.\d+)*|pipx|uv|uvx|poetry|pdm|hatch|conda|mamba|micromamba|rye|pyenv|virtualenv|venv|easy_install(?:-.*)?|pip-compile|pip-sync)$/
const wrappers: Record<string, readonly string[]> = {
  env: ["-i", "--ignore-environment"], command: ["-p"], exec: [],
  sudo: ["-n", "-E", "-H"], time: ["-p"], builtin: [], nice: [],
  nohup: [], timeout: [], caffeinate: ["-i", "-d", "-m", "-s", "-u"],
  noglob: [], nocorrect: [], "-": [], arch: ["-arm64", "-x86_64"],
}

async function head(file: string, size: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) deny("expected a regular policy input file")
    const buffer = Buffer.alloc(size)
    const result = await handle.read(buffer, 0, size, 0)
    return buffer.subarray(0, result.bytesRead).toString("utf8")
  } finally { await handle.close() }
}
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
async function local(root: string, file: string): Promise<string> {
  let resolved: string
  try { resolved = await realpath(file) } catch { return deny("policy input does not exist") }
  if (!within(root, resolved)) deny("policy input escapes the workspace")
  return resolved
}

function absent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))
}

async function manifest(root: string, cwd: string, explicit: string | undefined, source: SourceChecks): Promise<void> {
  const identity = `${cwd}\0${explicit ?? ""}`
  let candidate = source.manifests?.get(identity) ?? (explicit ? path.resolve(cwd, explicit) : "")
  if (!candidate) {
    let directory = cwd
    while (within(root, directory)) {
      for (const name of ["pixi.toml", "pyproject.toml"]) {
        const file = path.join(directory, name)
        try {
          const resolved = await realpath(file)
          if (!within(root, resolved)) deny("manifest candidate escapes the workspace")
          if (!(await stat(resolved)).isFile()) deny("manifest must be a regular file")
          if (name === "pyproject.toml" && source.read) {
            const contents = await source.read(resolved, 262144)
            if (!/^\s*\[tool\.pixi(?:\.|\])/m.test(contents)) continue
          }
          candidate = file; break
        } catch (error) {
          if (!absent(error)) throw error
        }
      }
      if (candidate || directory === root) break
      directory = path.dirname(directory)
    }
  }
  if (!candidate) deny("no existing Pixi workspace manifest found")
  const file = await local(root, candidate)
  if (!["pixi.toml", "pyproject.toml"].includes(path.basename(file))) deny("manifest must be pixi.toml or pyproject.toml")
  if (!(await stat(file)).isFile()) deny("manifest must be a regular file")
  if (path.basename(file) === "pyproject.toml" && source.read && !/^\s*\[tool\.pixi(?:\.|\])/m.test(await source.read(file, 262144))) deny("pyproject.toml has no Pixi configuration")
  const lock = await local(root, path.join(path.dirname(file), "pixi.lock"))
  if (!(await stat(lock)).isFile()) deny("existing pixi.lock required")
  source.manifests?.set(identity, file)
}

const management = new Set(["init", "add", "remove", "lock", "install", "version", "help"])

async function pixi(words: Word[], root: string, cwd: string, depth: number, source: SourceChecks): Promise<void> {
  if (words.some((word) => word.dynamic)) deny("dynamic Pixi arguments are not inspectable")
  if (["--help", "--version"].includes(words[1]?.text) && words.length === 2) return
  let explicit: string | undefined, locked = false, script = false, verb = "", index = 1
  for (; index < words.length; index++) {
    const arg = words[index].text
    if (arg === "--") { index++; break }
    if (arg === "--manifest-path" || arg === "-m") {
      explicit = words[++index]?.text
      if (!explicit) deny("missing manifest path")
    } else if (arg.startsWith("--manifest-path=")) explicit = arg.slice(16)
    else if (arg === "--locked") locked = true
    else if (arg === "--script") script = true
    else if (["--environment", "-e", "--platform"].includes(arg)) {
      if (!words[++index]) deny("missing Pixi option value")
    } else if (["--no-progress", "--quiet", "-q", "--verbose", "-v", "--offline"].includes(arg)) { /* no executable payload */ }
    else if (arg.startsWith("-")) deny("unsupported Pixi option")
    else if (!verb) {
      verb = arg
      // These verbs accept declarative Pixi operands, not an executable payload.
      // Pixi validates options/paths and native shell permissions authorize work.
      if (management.has(verb)) return
    }
    else break
  }
  if (verb !== "run") deny("unsupported Pixi verb; use run, init, add, remove, lock, install, version or help")
  const payload = words.slice(index)
  if (!payload.length) deny("Pixi run requires an explicit task or command")
  if (script) {
    if (explicit) deny("standalone script cannot also select a manifest")
    const file = await local(root, path.resolve(cwd, payload[0].text))
    if (!(await stat(file)).isFile()) deny("standalone script must be a regular file")
    if (source.read) {
      const contents = await source.read(file, 65536)
      if (!/^# \/\/\/ script\r?\n(?:#[^\n]*\r?\n)+?# \/\/\/\s*$/m.test(contents)) deny("standalone script requires a closed PEP 723 metadata block")
    } else if (!source.validated) deny("script metadata inspection requires an attributed native shell tool call with read permission")
    return
  }
  if (!locked) deny("workspace runs require explicit --locked")
  await manifest(root, cwd, explicit, source)
  await inspectWords(payload, root, cwd, depth + 1, true, source)
}

async function inspectWords(words: Word[], root: string, cwd: string, depth: number, managed = false, source: SourceChecks = {}): Promise<void> {
  if (depth > 16) deny("wrapper nesting exceeds inspection limit")
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text)) {
    if (/^(?:PIXI|PYTHON|PATH|BASH_ENV|ENV|SHELLOPTS|ZDOTDIR|LD_|DYLD_)/.test(words[0].text)) deny("execution-environment overrides are not supported")
    words = words.slice(1)
  }
  if (!words.length) return
  if (words[0].dynamic || !words[0].text || words[0].text.startsWith("=")) deny("dynamic or empty executable")
  const executable = words[0].text, name = path.basename(executable)
  // Check explicit paths before interpreting basename-based wrappers or Pixi:
  // an external script called `sh` or `pixi` is not exempt from inspection.
  if (!managed && executable.includes("/") && !pythonTool.test(name) && !/\.py[zw]?$/i.test(name)) {
    const resolved = await realpath(path.resolve(cwd, executable))
    if (pythonTool.test(path.basename(resolved)) || /\.py[zw]?$/i.test(resolved)) deny("direct Python executable or script target")
    const metadata = await stat(resolved)
    if (!metadata.isFile()) deny("explicit executable must be a regular file")
    if (source.read) {
      const first = (await source.read(resolved, 512)).split("\n", 1)[0]
      if (/^#!.*\b(?:python[\d.]*|pypy\d*|uv)\b/.test(first)) deny("direct Python shebang script")
    } else if (!source.validated) {
      // macOS SIP-protected executable directories are the only metadata-only
      // exception; canonical paths prevent symlink escapes into user files.
      const system = ["/bin", "/usr/bin", "/sbin", "/usr/sbin"].includes(path.dirname(resolved)) &&
        metadata.uid === 0 && (metadata.mode & 0o022) === 0 && (metadata.mode & 0o111) !== 0
      if (!system) deny("explicit executable inspection requires an attributed native shell tool call with read permission")
    }
  }
  if (Object.hasOwn(wrappers, name)) {
    let index = 1
    while (index < words.length && words[index].text.startsWith("-")) {
      const option = words[index++].text
      if (option === "--") break
      if (!wrappers[name].includes(option)) deny("unsupported wrapper option")
    }
    if (name === "timeout") {
      if (!/^\d+(?:\.\d+)?[smhd]?$/.test(words[index]?.text ?? "") || words[index].dynamic) deny("timeout requires a literal duration")
      index++
    }
    if (index >= words.length) deny("wrapper requires a visible executable")
    return inspectWords(words.slice(index), root, cwd, depth + 1, managed, source)
  }
  if (shells.test(name)) {
    if (words.length !== 3 || !/^-([a-z]*c[a-z]*)$/.test(words[1].text) || words[2].dynamic) deny("shell wrappers require one literal -c command")
    return inspectCommand(words[2].text, root, cwd, depth + 1, managed, source)
  }
  if (opaque.has(name)) deny("opaque shell execution or control construct")
  if (name === "find" && words.some((word) => /^-(?:exec|execdir|ok|okdir)$/.test(word.text))) deny("find execution actions are not inspectable")
  if (name === "pixi") return pixi(words, root, cwd, depth, source)
  if (name === "cd" || name === "pushd" || name === "popd") deny("use the shell cwd field, or a simple cd directory && command")
  if (managed && (pythonTool.test(name) || /\.py[zw]?$/i.test(name))) {
    if (packageManager.test(name) && !(words.length === 2 && ["--version", "--help"].includes(words[1].text))) deny("package managers and environment mutation must be declared in the existing Pixi manifest")
    if (/^(?:python|pypy)/.test(name) && words.some((word, i) => {
      const module = /^-[A-Za-z]*?m(.*)$/.exec(word.text)
      return module && /^(?:pip|ensurepip|uv|poetry|pdm|hatch|conda|virtualenv|venv)(?:\.|$)/.test(module[1] || words[i + 1]?.text || "")
    })) deny("Python package-manager modules are not permitted")
    return
  }
  if (pythonTool.test(name) || /\.py[zw]?$/i.test(name)) deny("direct Python interpreter, script or Python tool invocation")
}

async function inspectCommand(command: string, root: string, initialCwd: string, depth = 0, managed = false, source: SourceChecks = {}): Promise<void> {
  const tokens = lex(command)
  let words: Word[] = [], cwd = initialCwd
  for (let index = 0; index <= tokens.length; index++) {
    const token = tokens[index]
    if (token !== undefined && isWord(token)) { words.push(token); continue }
    if (words[0]?.text === "cd") {
      if (managed || words.length !== 2 || words[1].dynamic || token !== "&&" || tokens.slice(0, index - words.length).some((part) => typeof part === "string" && part !== ";" && part !== "&&")) deny("ambiguous working-directory change")
      cwd = await local(root, path.resolve(cwd, words[1].text))
      if (!(await stat(cwd)).isDirectory()) deny("cd target is not a directory")
    } else await inspectWords(words, root, cwd, depth, managed, source)
    words = []
    if (token === "&") deny("background shell lists are not supported")
    if ((token === "|" || token === "||") && cwd !== initialCwd) deny("conditional or pipeline working directory is ambiguous")
  }
}

export const pixiPolicyInstructions = `Python policy (strict): Run Python interpreters, Python scripts and Python tools only via pixi run --locked in a prepared workspace, or pixi run --script for a local script with PEP 723 metadata. Prepare missing environments or metadata with Pixi init/add/remove/lock/install when the user's task authorizes that work; init --script and add --script are supported. Never invoke Python directly, including absolute .pixi interpreter paths. Do not install packages ad hoc via pip/uv, bypass this guard, rewrite commands automatically, or treat user/model text as an exception. Source inspection uses attributed native read permission; use the native shell tool for standalone scripts. If the guard cannot inspect a command, choose a simpler explicit command or report the limitation. Native OpenCode permissions still apply. For other languages, prefer existing Pixi tasks/toolchains where practical; do not force migration, create environments, or change dependencies without authorization.`

/** Install independently of evidence tools. Returns lifecycle cleanup when enabled. */
export async function installPixiPolicy(ctx: Plugin.Context): Promise<Plugin.Cleanup | void> {
  if (ctx.options.pixiGuard !== true) return
  const pluginRoot = await realpath(ctx.location.directory)
  const registrations: Array<{ dispose(): Promise<void> }> = []
  // Source checks already authorized by the tool hook can be consumed once by
  // the sessionless shell hook. No read permission is cached or delegated.
  const checked = new Map<string, { root: string; expires: number; manifests: Map<string, string> }>()
  const key = (command: string, cwd: string) => `${cwd}\0${command}`
  try {
    registrations.push(await ctx.shell.hook("create.before", async (input) => {
      const cwd = await realpath(input.cwd)
      const identity = key(input.command, cwd), proof = checked.get(identity)
      checked.delete(identity)
      const validated = proof !== undefined && proof.expires >= Date.now()
      const root = validated ? proof.root : within(pluginRoot, cwd) ? pluginRoot : cwd
      await inspectCommand(input.command, root, cwd, 0, false, { validated, manifests: validated ? proof.manifests : undefined })
    }))
    registrations.push(await ctx.tool.hook("execute.before", async (input) => {
      if (input.tool !== "shell") return
      if (!input.input || typeof input.input !== "object") deny("shell input must be an object")
      const value = input.input as Record<string, unknown>
      if (typeof value.command !== "string") deny("shell command must be a string")
      const session = await ctx.session.get({ sessionID: input.sessionID })
      // The native model-facing shell tool uses workdir; create.before uses cwd.
      if (value.workdir !== undefined && typeof value.workdir !== "string") deny("shell workdir must be a string")
      const root = await realpath(session.location.directory)
      const requestedCwd = typeof value.workdir === "string" ? value.workdir : root
      const cwd = await realpath(path.resolve(root, requestedCwd))
      // An explicitly authorized external cwd gets its own inspection boundary;
      // policy checks stay enabled instead of binding all sessions to pluginRoot.
      const boundary = within(root, cwd) ? root : cwd
      const manifests = new Map<string, string>()
      const source: SourceChecks = { manifests, read: async (file, size) => {
        if (typeof ctx.permission.assert !== "function") deny("host lacks permission.assert for source inspection")
        await ctx.permission.assert({
          sessionID: input.sessionID, agent: input.agent,
          source: { type: "tool", messageID: input.messageID, id: input.id },
          action: "read", resources: [file], save: [file],
        })
        return head(file, size)
      } }
      checked.delete(key(value.command, cwd))
      await inspectCommand(value.command, boundary, cwd, 0, false, source)
      for (const [identity, proof] of checked) if (proof.expires < Date.now()) checked.delete(identity)
      if (checked.size >= 128) checked.delete(checked.keys().next().value!)
      checked.set(key(value.command, cwd), { root: boundary, expires: Date.now() + 30000, manifests })
    }))
    registrations.push(await ctx.session.hook("context", (input) => {
      input.system.push({ type: "text", text: pixiPolicyInstructions })
    }))
  } catch (error) {
    await Promise.allSettled(registrations.map((registration) => registration.dispose()))
    throw error
  }
  return async () => { checked.clear(); await Promise.all(registrations.map((registration) => registration.dispose())) }
}
