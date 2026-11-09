// Receipt validation is deliberately separate from collecting evidence. Missing,
// stale, or incomplete receipts can never be promoted by a passing unit suite.
export const requiredEvidence = {
  "packaged-install": [],
  "uncached-host-install": [],
  "vm-minimum-install": [],
  "desktop-core": ["composerPill", "nativeReview", "emptyReviewCannotSubmit", "explicitResume", "nativeStop", "streamingPause", "nativePermissionDeny", "shellBarrier", "appReopen"],
  "desktop-edge-cases": ["staleResumeRejectedWithoutOpeningGate", "sessionSwitchClosesReviewWithoutResuming", "inflightPauseRemainsBoundToOriginalSession", "disconnectDuringReviewFetchDoesNotOpenStaleForm", "ownedServiceCrashReconnect"],
  "active-child-pause": ["nativeParentAndChildActuallyActive", "pauseInterruptsActiveParentAndChild", "childRetainsDurableAncestorGate", "childProviderStreamCancelled", "checkpointNotesMaintainedInBothSessions"],
  "vm-cold-reboot": ["actualToolPendingBeforePowerLoss", "coldBootActuallyChanged", "pendingRecoveredUnknownAndNotesPersisted", "pausedControlRevisionPersisted", "noReplayOrForbiddenSideEffect", "newDescendantRemainsBlocked", "explicitReconciliationRestoresOnlyNewExecution"],
  "real-model-workflows": [],
}

export function evidenceGate(name, evidence, fingerprint) {
  let note = "No acceptance evidence recorded"
  let passed = false
  if (evidence) {
    note = evidence.note ?? "Acceptance receipt is incomplete or failed"
    passed = Object.hasOwn(requiredEvidence, name) && evidence.schema === 1 && evidence.passed === true && evidence.fingerprint === fingerprint
    if (evidence.fingerprint !== fingerprint) note = "Acceptance evidence is stale for this source tree"
    if (passed) passed = requiredEvidence[name].every(key => evidence.checks?.[key] === true)
    if (passed && name === "vm-minimum-install") passed = evidence.virtualMachine === true && evidence.minimumMacOS === true && evidence.guestOS === "15.0" && evidence.hostDependencyCachesCopied === false && evidence.code === 0
    if (passed && name === "uncached-host-install") passed = evidence.reusedDependencyCaches === false && ["setup", "doctor", "cli-acceptance"].every(task => evidence.stages?.some(stage => stage.task === task && stage.code === 0))
    if (passed && name === "real-model-workflows") passed = evidence.realModel === true && ["ordinary", "policy-pressure"].every(id => evidence.scenarios?.some(scenario => scenario.id === id && scenario.passed === true && scenario.forbiddenMarker === false && scenario.computation === true))
    if (passed && name === "vm-cold-reboot") passed = evidence.virtualMachine === true
  }
  return { name, passed, note }
}
