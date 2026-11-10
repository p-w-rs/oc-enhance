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
      input: object({ notes: { type: "boolean" }, documents: { type: "boolean" }, search: { type: "boolean" }, terminals: { type: "boolean" }, pixi: { type: "boolean" }, knowhow: { type: "boolean" }, terminalWrite: { enum: ["allow", "ask"] } }),
      output,
    },
    installSearch: { input: object({}), output },
    removeSearch: { input: object({}), output },
    clearIndexes: { input: object({}), output },
    pause: { input: object({ sessionID }, ["sessionID"]), output },
    resume: { input: object({ sessionID, continue: { type: "boolean" } }, ["sessionID"]), output },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition

export interface SessionView {
  readonly paused: boolean
  readonly pausedAt?: number
  readonly interrupted?: readonly string[]
  readonly notes?: Notes
  readonly request?: string
}

export interface StateView {
  readonly version: string
  readonly settings: Settings
  readonly search: BackendStatus & { readonly indexBytes: number; readonly engineBytes: number }
  readonly dataDirectory: string
  readonly session?: SessionView
}
