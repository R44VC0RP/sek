import { Rpc } from "@opencode/plugin/rpc"

/**
 * How the server plugin asks a TUI to approve agent key requests.
 *
 * The server emits `requested`; a TUI answers `ack` at once (so the server knows someone is
 * watching) and `decide` once the user picks. `resolved` tells other TUIs to close their dialog.
 */
export const Sek = Rpc.define({
  id: "sek",
  methods: {
    ack: {
      input: {
        type: "object",
        properties: { requestID: { type: "string" } },
        required: ["requestID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    decide: {
      input: {
        type: "object",
        properties: {
          requestID: { type: "string" },
          decision: { type: "string", enum: ["once", "session", "deny"] },
        },
        required: ["requestID", "decision"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {
    requested: {
      schema: {
        type: "object",
        properties: {
          requestID: { type: "string" },
          sessionID: { type: "string" },
          names: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["requestID", "sessionID", "names", "reason"],
        additionalProperties: false,
      },
    },
    resolved: {
      schema: {
        type: "object",
        properties: {
          requestID: { type: "string" },
          decision: { type: "string" },
        },
        required: ["requestID", "decision"],
        additionalProperties: false,
      },
    },
  },
})

export type Decision = "once" | "session" | "deny"
