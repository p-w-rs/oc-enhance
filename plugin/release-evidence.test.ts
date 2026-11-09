import test from "node:test"
import assert from "node:assert/strict"

test("release evidence rejects stale, missing and incomplete receipts without requiring optional physical sleep", async () => {
  const { evidenceGate, requiredEvidence } = await import(new URL("../scripts/release-evidence.mjs", import.meta.url).href)
  const fingerprint = "synthetic-fingerprint"
  const base = { schema: 1, fingerprint, passed: true }
  assert.equal(evidenceGate("desktop-core", undefined, fingerprint).passed, false)
  assert.equal(evidenceGate("desktop-core", base, fingerprint).passed, false)
  const checks = Object.fromEntries(requiredEvidence["desktop-core"].map((key: string) => [key, true]))
  assert.equal(evidenceGate("desktop-core", { ...base, checks }, fingerprint).passed, true)
  assert.equal(evidenceGate("desktop-core", { ...base, checks }, "changed").passed, false)
  assert.equal(evidenceGate("desktop-core", { ...base, checks: { ...checks, nativeStop: false } }, fingerprint).passed, false)
  assert.equal(evidenceGate("invented", base, fingerprint).passed, false)
  const guest = { ...base, virtualMachine: true, minimumMacOS: true, guestOS: "15.0", hostDependencyCachesCopied: false, code: 0 }
  assert.equal(evidenceGate("vm-minimum-install", guest, fingerprint).passed, true)
  assert.equal(evidenceGate("vm-minimum-install", { ...guest, hostDependencyCachesCopied: true }, fingerprint).passed, false)
  assert.equal(evidenceGate("vm-minimum-install", { ...guest, guestOS: "26.6.2" }, fingerprint).passed, false)
  assert.equal(Object.hasOwn(requiredEvidence, "physical-sleep-wake"), false)
})
