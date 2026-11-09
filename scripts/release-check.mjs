import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { releaseFingerprint } from "./release-fingerprint.mjs"
import { evidenceGate, requiredEvidence } from "./release-evidence.mjs"

const gates = []
const pixi = process.env.OPEN_ENHANCE_PIXI ?? process.env.PIXI_EXE ?? "pixi"
const pythonTests = spawnSync(pixi, ["run", "--as-is", "--offline", "python", "-m", "pytest", "-q"], { stdio: "inherit" })
gates.push({ name: "python-tests", passed: pythonTests.status === 0 })
for (const [name, args] of [
  ["node-sdk-tests", ["test"]],
  ["typescript", ["run", "check"]],
  ["gui-bundle", ["run", "build"]],
  ["package-contents", ["run", "pack:check"]],
]) {
  const result = spawnSync("npm", args, { stdio: "inherit" })
  gates.push({ name, passed: result.status === 0 })
}
const fingerprint = releaseFingerprint()
const cli = spawnSync(pixi, ["run", "--locked", "cli-acceptance"], { stdio: "inherit" })
gates.push({ name: "actual-cli-acceptance", passed: cli.status === 0, note: "Native CLI with local scripted provider; not real-LLM quality or Desktop acceptance" })
const pythonAudit = spawnSync(pixi, ["run", "--locked", "python-audit"], { stdio: "inherit" })
gates.push({ name: "python-dependency-audit", passed: pythonAudit.status === 0, note: "Audits installed Python distributions; not a complete native/Conda advisory scan" })
const audit = spawnSync("npm", ["audit", "--json", "--cache", ".local/npm-cache"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
let vulnerabilities
try { vulnerabilities = JSON.parse(audit.stdout).metadata.vulnerabilities } catch { vulnerabilities = { auditUnavailable: true } }
gates.push({ name: "dependency-audit", passed: audit.status === 0, vulnerabilities })
// These require real evidence, never assertions inferred from passing unit tests.
for (const name of Object.keys(requiredEvidence)) {
  let evidence
  try { evidence = JSON.parse(readFileSync(`.local/release/${name}.json`, "utf8")) } catch { /* missing */ }
  gates.push(evidenceGate(name, evidence, fingerprint))
}
const report = { schema: 1, fingerprint, scope: "Technical readiness for the documented opt-in macOS arm64 candidate; not authorization to publish", releaseReady: gates.every(gate => gate.passed), publicationReady: false, optionalUnverified: ["physical-sleep-wake", "minimum-os-desktop", "independent-physical-mac"], gates }
mkdirSync(".local/release", { recursive: true, mode: 0o700 })
writeFileSync(".local/release/release-check.json", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.releaseReady ? 0 : 1
