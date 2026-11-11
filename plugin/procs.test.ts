import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { stopCommands } from "./procs.js"

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test("stops a background shell's whole process tree, and only that one", async () => {
  const marker = `oce-procs-${process.pid}-${Date.now()}`
  const target = spawn("/bin/bash", ["-c", `sleep 300 & sleep 301; echo ${marker}`], { stdio: "ignore" })
  const bystander = spawn("/bin/bash", ["-c", `sleep 302; echo ${marker}-other`], { stdio: "ignore" })
  await new Promise(resolve => setTimeout(resolve, 300))
  const stopped = await stopCommands([`sleep 300 & sleep 301; echo ${marker}`, "not running at all"], process.pid, 200)
  assert.deepEqual(stopped, [`sleep 300 & sleep 301; echo ${marker}`])
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(alive(target.pid!), false)
  assert.equal(alive(bystander.pid!), true, "other shells keep running")
  bystander.kill("SIGKILL")
  assert.deepEqual(await stopCommands([]), [])
})
