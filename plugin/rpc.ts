import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

/** Durable server state, not a promise that it is safe to close the app. */
export interface CheckpointView {
  readonly state: string
  readonly revision?: number
  readonly [key: string]: unknown
}

const input = {
  type: "object", properties: { sessionID: { type: "string", minLength: 1 } },
  required: ["sessionID"], additionalProperties: false,
} as const
const output = Schema.toStandardSchemaV1(Schema.Unknown)

export interface ResumeInput {
  readonly revision: number
  readonly reconciliation: string
  readonly acknowledgeUnknown: boolean
}

export function resumeInput(value: ResumeInput): ResumeInput {
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.reconciliation !== "string" || !value.reconciliation.trim() || value.reconciliation.length > 1000 ||
      typeof value.acknowledgeUnknown !== "boolean") throw new Error("Explicit reconciliation and a current revision are required")
  return { revision: value.revision, reconciliation: value.reconciliation, acknowledgeUnknown: value.acknowledgeUnknown }
}

// Standard Schema keeps Schema.Unknown portable to the desktop Promise client.
// JSON input is unknown in TypeScript; server handlers narrow it explicitly.
export const Checkpoints = Rpc.define({
  id: "open-enhance.checkpoints",
  methods: {
    pause: { input, output },
    resume: { input: {
      type: "object", properties: {
        ...input.properties, revision: { type: "integer", minimum: 0 },
        reconciliation: { type: "string", minLength: 1, maxLength: 1000 },
        acknowledgeUnknown: { type: "boolean" },
      }, required: ["sessionID", "revision", "reconciliation", "acknowledgeUnknown"], additionalProperties: false,
    }, output },
    status: { input, output },
  },
  events: {},
})

export function checkpointView(value: unknown): CheckpointView {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid checkpoint status response")
  }
  const wrapper = value as Record<string, unknown>
  const data = wrapper.status && typeof wrapper.status === "object" ? wrapper.status as Record<string, unknown> : wrapper
  const failures = (Array.isArray(wrapper.interruptFailures) && wrapper.interruptFailures.length > 0) ||
    (Array.isArray(data.sessions) && data.sessions.some((entry: unknown) => !!entry && typeof entry === "object" && "interruptFailures" in entry && Array.isArray(entry.interruptFailures) && entry.interruptFailures.length > 0))
  if (typeof data.state === "string") return { ...data, state: failures ? "paused with unresolved operations" : data.state } as CheckpointView
  if (!Number.isSafeInteger(data.revision) || !Array.isArray(data.sessions) || !Array.isArray(data.journal) || !Array.isArray(data.blockedBy)) throw new Error("Invalid checkpoint status response")
  const unresolved = data.journal.some((entry: unknown) => entry && typeof entry === "object" && "outcome" in entry &&
    (entry.outcome === "pending" || (entry.outcome === "unknown" && (!("acknowledged" in entry) || entry.acknowledged !== true))))
  return { ...data, revision: data.revision as number, state: failures ? "paused with unresolved operations" :
    unresolved ? "unknown" : data.blockedBy.length > 0 ? "paused" : "running" }
}
