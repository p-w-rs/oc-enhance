import { spawn } from "node:child_process"
import path from "node:path"

/** Explicit allowlist: never pass provider keys, config content, or loader hooks. */
export function createWorkerEnvironment(repository: string, dataDirectory: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
    "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE",
  ]) {
    if (source[key] !== undefined) env[key] = source[key]
  }
  env.PATH = [path.join(repository, ".pixi", "envs", "default", "bin"), ...(source.PATH ? [source.PATH] : []), "/usr/bin", "/bin"].join(path.delimiter)
  env.OPEN_ENHANCE_HOME = dataDirectory
  env.PYTHONNOUSERSITE = "1"
  env.PYTHONDONTWRITEBYTECODE = "1"
  return env
}

export interface WorkerOptions {
  executable: string
  args: readonly string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxStdout?: number
  maxStderr?: number
}

/** Own the complete process lifetime, including cancellation and pipe draining. */
export class WorkerPool {
  private active = new Set<{ stop: () => void; done: Promise<unknown> }>()
  private closed = false

  async run(input: unknown, options: WorkerOptions, signal: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("open-enhance worker pool is closed")
    signal.throwIfAborted()
    const request = JSON.stringify(input)
    if (request === undefined || Buffer.byteLength(request) > 2 * 1024 * 1024) throw new Error("open-enhance worker request exceeds 2 MiB or is invalid")
    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    let failure: Error | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error
      }
    }
    const stop = () => {
      kill("SIGTERM")
      escalation ??= setTimeout(() => kill("SIGKILL"), 250)
    }
    const abort = () => {
      failure ??= new Error("open-enhance worker cancelled")
      stop()
    }
    let stdoutSize = 0
    let stderrSize = 0
    const stdout: Buffer[] = []
    child.stdout.on("data", (data: Buffer) => {
      stdoutSize += data.length
      if (stdoutSize > (options.maxStdout ?? 2 * 1024 * 1024)) {
        failure ??= new Error("open-enhance worker stdout exceeded limit")
        stop()
      } else stdout.push(data)
    })
    child.stderr.on("data", (data: Buffer) => {
      stderrSize += data.length
      if (stderrSize > (options.maxStderr ?? 64 * 1024)) {
        failure ??= new Error("open-enhance worker stderr exceeded limit")
        stop()
      }
    })
    // Never surface untrusted worker stderr (which may contain source text) as diagnostics.
    child.stdin.on("error", () => {})
    const done = new Promise<unknown>((resolve, reject) => {
      child.on("error", (error) => { failure ??= error })
      child.on("close", (code, terminationSignal) => {
        clearTimeout(timer)
        if (escalation) {
          // A leader can exit before its descendants. Finish killing the owned group.
          kill("SIGKILL")
          clearTimeout(escalation)
        }
        signal.removeEventListener("abort", abort)
        if (failure) return reject(failure)
        if (code !== 0) return reject(new Error(`open-enhance worker failed (exit ${code}, signal ${terminationSignal ?? "none"}); stderr withheld`))
        try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8"))) }
        catch { reject(new Error("open-enhance worker returned invalid JSON")) }
      })
    })
    const timer = setTimeout(() => {
      failure ??= new Error("open-enhance worker timed out")
      stop()
    }, options.timeoutMs ?? 120_000)
    const entry = { stop: () => { failure ??= new Error("open-enhance plugin unloaded"); stop() }, done }
    this.active.add(entry)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    try {
      child.stdin.end(request)
      return await done
    } finally { this.active.delete(entry) }
  }

  async close(): Promise<void> {
    this.closed = true
    const entries = [...this.active]
    entries.forEach((entry) => entry.stop())
    await Promise.allSettled(entries.map((entry) => entry.done))
  }
}
