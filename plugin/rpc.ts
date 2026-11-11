import type { Rpc } from "@opencode/plugin/rpc"
import type { BackendStatus } from "./backend.js"
import type { Notes } from "./notes.js"
import type { Settings } from "./settings.js"

const output = {} as const
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false }) as const
const sessionID = { type: "string", minLength: 1, maxLength: 200 }

export const EnhanceRpc = {
  id: "oc-enhance.admin",
  methods: {
    state: { input: object({ sessionID }), output },
    session: { input: object({ sessionID }, ["sessionID"]), output },
    update: {
      input: object({ notes: { type: "boolean" }, reminders: { type: "boolean" }, topOfMind: { type: "boolean" }, topOfMindModel: { type: "string", maxLength: 300 }, documents: { type: "boolean" }, search: { type: "boolean" }, terminals: { type: "boolean" }, terminalWrite: { enum: ["allow", "ask"] } }),
      output,
    },
    installSearch: { input: object({}), output },
    removeSearch: { input: object({}), output },
    clearIndexes: { input: object({}), output },
    pause: { input: object({ sessionID }, ["sessionID"]), output },
    resume: { input: object({ sessionID, continue: { type: "boolean" } }, ["sessionID"]), output },
    models: { input: object({}), output },
    cancelReminder: { input: object({ sessionID, id: { type: "string", minLength: 1, maxLength: 100 } }, ["sessionID", "id"]), output },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition

export interface SessionView {
  readonly paused: boolean
  readonly pausedAt?: number
  readonly interrupted?: readonly string[]
  readonly background?: readonly string[]
  readonly checkpoint?: "saving" | "saved" | "failed"
  readonly reminders?: readonly { readonly id: string; readonly message: string; readonly due: number; readonly every?: number }[]
  readonly notes?: Notes
  readonly topOfMind?: { readonly cues: readonly { readonly name: string; readonly why: string; readonly source: string }[]; readonly at: number }
  readonly saved?: { readonly at: number; readonly by: "agent" | "checkpoint" }
  readonly request?: string
}

export interface StateView {
  readonly version: string
  readonly settings: Settings
  readonly search: BackendStatus & { readonly indexBytes: number; readonly engineBytes: number }
  readonly dataDirectory: string
  readonly session?: SessionView
}
