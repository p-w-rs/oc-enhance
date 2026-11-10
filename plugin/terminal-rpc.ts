import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

const output = Schema.toStandardSchemaV1(Schema.Unknown)

/**
 * Relay between the server plugin (which has the agent's tools) and Desktop windows (which can reach terminals):
 * the server emits `request`; a window `claim`s it (only the first succeeds), runs it, and `respond`s.
 */
export const Terminals = Rpc.define({
  id: "open-enhance.terminals",
  methods: {
    claim: { input: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 100 } }, required: ["id"], additionalProperties: false }, output },
    respond: {
      input: {
        type: "object",
        properties: { id: { type: "string", minLength: 1, maxLength: 100 }, ok: { type: "boolean" }, result: {}, error: { type: "string", maxLength: 2000 } },
        required: ["id", "ok"], additionalProperties: false,
      },
      output,
    },
  },
  events: {
    request: { schema: { type: "object", properties: { id: { type: "string" }, operation: { type: "object" } }, required: ["id", "operation"] } },
  },
})
