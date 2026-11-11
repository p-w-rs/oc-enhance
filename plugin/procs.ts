// Stopping background shells on Pause. OpenCode gives plugins no way to stop a shell, so we find its process among
// this OpenCode process's descendants (a background shell runs as `<shell> -c <command>`) and stop that process tree.
import { execFile } from "node:child_process"

interface Proc { pid: number; ppid: number; command: string }

async function processes(): Promise<Proc[]> {
  const output = await new Promise<string>((resolve, reject) => execFile("ps", ["-A", "-ww", "-o", "pid=,ppid=,command="], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
  return output.split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(match => !!match).map(match => ({ pid: Number(match![1]), ppid: Number(match![2]), command: match![3]! }))
}

const descendants = (all: Proc[], root: number): Proc[] => {
  const children = new Map<number, Proc[]>()
  for (const proc of all) { const list = children.get(proc.ppid) ?? []; list.push(proc); children.set(proc.ppid, list) }
  const found: Proc[] = []
  const queue = [root]
  while (queue.length) for (const child of children.get(queue.shift()!) ?? []) { found.push(child); queue.push(child.pid) }
  return found
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim()
const SHELL = /(^|\/)(ba|z|da|k|fi)?sh\s+(-\S+\s+)*-c\s/

/**
 * Stops the process trees of these shell commands if they run under `root` (default: this process): SIGTERM, then
 * SIGKILL for anything still alive after `graceMs`. Returns the commands that were found.
 */
export async function stopCommands(commands: readonly string[], root = process.pid, graceMs = 1500): Promise<string[]> {
  const wanted = [...new Set(commands.map(squash).filter(Boolean))]
  if (!wanted.length) return []
  let all: Proc[]
  try { all = await processes() } catch { return [] }
  const mine = descendants(all, root)
  const stopped: string[] = []
  const targets = new Set<number>()
  for (const command of wanted) {
    const shells = mine.filter(proc => SHELL.test(proc.command) && squash(proc.command).endsWith(command))
    if (!shells.length) continue
    stopped.push(command)
    for (const shell of shells) { targets.add(shell.pid); for (const child of descendants(all, shell.pid)) targets.add(child.pid) }
  }
  const signal = (name: NodeJS.Signals) => { for (const pid of targets) { try { process.kill(pid, name) } catch {} } }
  signal("SIGTERM")
  if (targets.size) { await new Promise(resolve => setTimeout(resolve, graceMs)); signal("SIGKILL") }
  return stopped
}
