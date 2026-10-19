import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Sek, type Decision } from "./rpc.js"

/**
 * Lets agents request API keys from sek without ever seeing them.
 *
 * `sek_request` reads the secrets (Touch ID, or nothing when `sek unlock` is active) and grants
 * them to the session. Granted values are injected as environment variables into that session's
 * shell commands and scrubbed from every tool result before the model sees it.
 */

type Grant = { name: string; env: string; value: string; expires: number }

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/
const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/
const PENDING_MS = 5 * 60_000
const MIN_REDACT = 8
const TAG = /\n# sek:([0-9a-f-]{36})$/
/** How long to wait for any TUI to acknowledge a request before treating the session as headless. */
const ACK_MS = 3_000
/** How long the user has to answer the approval dialog. */
const DECIDE_MS = 5 * 60_000

type Outcome = Decision | "headless" | "timeout" | "aborted"

function findBinary(configured: unknown): string {
  if (typeof configured === "string" && configured) return configured
  const candidates = [
    ...(process.env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, "sek")),
    join(homedir(), ".local/bin/sek"),
    "/opt/homebrew/bin/sek",
    "/usr/local/bin/sek",
  ]
  return candidates.find((path) => existsSync(path)) ?? "sek"
}

function sek(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // Touch ID can take a while; sek itself gives up after two minutes.
    execFile(bin, args, { signal, timeout: 150_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().replace(/^sek: /, "")))
      else resolve(String(stdout))
    })
  })
}

function envNameFor(name: string): string {
  const env = name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")
  return /^[0-9]/.test(env) ? `_${env}` : env
}

export default Plugin.define({
  id: "sek",
  async setup(ctx) {
    const bin = findBinary(ctx.options.bin)
    const ttlMinutes = typeof ctx.options.ttlMinutes === "number" ? ctx.options.ttlMinutes : 60
    // Without a TUI (e.g. `opencode run`), Touch ID is the only gate unless this is set.
    const requireApproval = ctx.options.requireApproval === true

    /** requestID → waiting approval */
    const approvals = new Map<
      string,
      { acked: boolean; onAck: () => void; resolve: (decision: Outcome) => void }
    >()
    /** sessionID → key names the user approved for the rest of the session */
    const approvedForSession = new Map<string, Set<string>>()

    const rpc = await ctx.rpc.register(Sek, {
      ack: async (input) => {
        const pending = approvals.get((input as { requestID: string }).requestID)
        if (pending && !pending.acked) {
          pending.acked = true
          pending.onAck()
        }
        return { ok: pending !== undefined }
      },
      decide: async (input) => {
        const { requestID, decision } = input as { requestID: string; decision: Decision }
        const pending = approvals.get(requestID)
        pending?.resolve(decision)
        return { ok: pending !== undefined }
      },
    })

    /** Asks any attached TUI to approve. Resolves "headless" when no TUI acknowledges. */
    const approve = async (
      sessionID: string,
      names: string[],
      reason: string,
      signal: AbortSignal,
    ): Promise<Outcome> => {
      if (signal.aborted) return "aborted"
      const approved = approvedForSession.get(sessionID)
      if (approved && names.every((name) => approved.has(name))) return "session"

      const requestID = randomUUID()
      let ackTimer: ReturnType<typeof setTimeout> | undefined
      let decideTimer: ReturnType<typeof setTimeout> | undefined
      const result = new Promise<Outcome>((resolve) => {
        const finish = (decision: Outcome) => {
          clearTimeout(ackTimer)
          clearTimeout(decideTimer)
          signal.removeEventListener("abort", onAbort)
          approvals.delete(requestID)
          resolve(decision)
        }
        const onAbort = () => finish("aborted")
        signal.addEventListener("abort", onAbort)
        approvals.set(requestID, {
          acked: false,
          onAck: () => {
            clearTimeout(ackTimer)
            decideTimer = setTimeout(() => finish("timeout"), DECIDE_MS)
          },
          resolve: finish,
        })
        ackTimer = setTimeout(() => finish("headless"), ACK_MS)
      })
      // The reason comes from the agent: keep it to one short plain line in the dialog.
      const shown = reason.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 120)
      await rpc.events.emit("requested", { requestID, sessionID, names, reason: shown })
      const decision = await result
      // Always announce the end, so a dialog opened late (after a headless fallback) closes.
      await rpc.events.emit("resolved", { requestID, decision }).catch(() => {})
      if (decision === "session") {
        const set = approvedForSession.get(sessionID) ?? new Set<string>()
        names.forEach((name) => set.add(name))
        approvedForSession.set(sessionID, set)
      }
      return decision
    }

    /** sessionID → env var → grant */
    const grants = new Map<string, Map<string, Grant>>()
    /** sessionID → value → name, longest value first; kept after expiry so leaked copies stay redacted */
    const redactions = new Map<string, Map<string, string>>()
    /** one-time tag appended to a shell tool call → the session that issued it */
    const pending = new Map<string, { sessionID: string; at: number }>()

    const active = (sessionID: string) => {
      const session = grants.get(sessionID)
      if (!session) return []
      const now = Date.now()
      for (const [env, grant] of session) if (grant.expires <= now) session.delete(env)
      return [...session.values()]
    }

    const scrub = <T>(value: T, secrets: Map<string, string>): T => {
      if (typeof value === "string") {
        let text: string = value
        for (const [secret, name] of secrets) text = text.split(secret).join(`[sek:${name}]`)
        return text as T
      }
      if (Array.isArray(value)) return value.map((item) => scrub(item, secrets)) as T
      const proto = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined
      if (proto === Object.prototype || proto === null) {
        const entries = Object.entries(value as Record<string, unknown>)
        return Object.fromEntries(entries.map(([k, v]) => [k, scrub(v, secrets)])) as T
      }
      return value
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "sek_list",
        description:
          "List the API keys stored in sek (names only, never values), whether a sek session is unlocked, " +
          "and which keys are granted to this session. Use before sek_request to find the right name.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context) => {
          const [names, status] = await Promise.all([
            sek(bin, ["list"], context.signal),
            sek(bin, ["status"], context.signal),
          ])
          const granted = active(context.sessionID)
          const lines = [
            `Stored keys: ${names.trim().split("\n").filter(Boolean).join(", ") || "(none)"}`,
            `sek session: ${status.trim()}`,
            granted.length
              ? `Granted to this session: ${granted.map((g) => `${g.name} as $${g.env}`).join(", ")}`
              : "Granted to this session: none",
          ]
          return { content: lines.join("\n") }
        },
      })

      editor.add({
        name: "sek_request",
        description:
          "Request API keys from sek (the user's Secure Enclave key store) for this session. The user approves " +
          "with Touch ID unless they unlocked a sek session. You never receive the values: each granted key is " +
          "set as an environment variable in every shell command you run afterwards in this session, and any " +
          "copy of a value in tool output is replaced with [sek:NAME]. Use it as \"$ENV_VAR\" in commands; " +
          "never print, echo, log, or write a key to a file.",
        input: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description: "sek key names, as shown by sek_list",
            },
            reason: { type: "string", description: "Short reason shown to the user, e.g. 'run the OpenAI eval script'" },
            env: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Optional map of key name to environment variable name. Defaults to the uppercased name.",
            },
          },
          required: ["names", "reason"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const { names: requested, reason, env = {} } = input as {
            names: string[]
            reason: string
            env?: Record<string, string>
          }
          const names = [...new Set(requested)]
          for (const name of names) {
            if (!NAME.test(name)) throw new ToolError({ message: `Invalid key name '${name}'` })
            const variable = env[name] ?? envNameFor(name)
            if (!ENV.test(variable)) throw new ToolError({ message: `Invalid environment variable '${variable}'` })
          }

          await context.progress({ status: `Waiting for approval to use ${names.join(", ")}` })
          const decision = await approve(context.sessionID, names, reason, context.signal)
          if (decision === "deny") {
            throw new ToolError({ message: `The user denied access to ${names.join(", ")}. Do not retry unless asked.` })
          }
          if (decision === "timeout") {
            throw new ToolError({ message: `Nobody answered the approval request for ${names.join(", ")}.` })
          }
          if (decision === "aborted") {
            throw new ToolError({ message: "The request was cancelled before it was approved." })
          }
          if (decision === "headless" && requireApproval) {
            throw new ToolError({ message: "sek needs approval in the OpenCode TUI, and no TUI is attached." })
          }

          // Applies the user's permission rules for action "sek" (resources are key names). Older
          // OpenCode builds lack assert(); Touch ID (or an explicit `sek unlock`) still gates access.
          await ctx.permission.assert?.({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "sek",
            resources: names,
            save: names,
            metadata: { reason },
          })

          await context.progress({ status: `Waiting for Touch ID to read ${names.join(", ")}` })
          let values: Record<string, string>
          try {
            values = JSON.parse(await sek(bin, ["get", "--json", ...names], context.signal))
          } catch (error) {
            throw new ToolError({ message: `sek: ${error instanceof Error ? error.message : String(error)}` })
          }

          const missing = names.filter((name) => typeof values[name] !== "string")
          if (missing.length) throw new ToolError({ message: `sek returned no value for ${missing.join(", ")}` })

          const expires = Date.now() + ttlMinutes * 60_000
          const session = grants.get(context.sessionID) ?? new Map<string, Grant>()
          const secrets = new Map(redactions.get(context.sessionID))
          for (const name of names) {
            const value = values[name]!
            const variable = env[name] ?? envNameFor(name)
            session.set(variable, { name, env: variable, value, expires })
            if (value.length >= MIN_REDACT) secrets.set(value, name)
          }
          grants.set(context.sessionID, session)
          // Longest first, so a value that contains a shorter one is still replaced whole.
          redactions.set(context.sessionID, new Map([...secrets].sort((a, b) => b[0].length - a[0].length)))

          const granted = names.map((name) => `${name} as $${env[name] ?? envNameFor(name)}`).join(", ")
          return {
            content:
              `Granted ${granted} for ${ttlMinutes} minutes. These are set in every shell command you run in ` +
              `this session. Reference them as "$VAR"; the values are hidden from you and redacted from output.`,
            metadata: { names, ttlMinutes },
          }
        },
      })

      editor.add({
        name: "sek_revoke",
        description: "Stop injecting sek keys into this session's shell commands. Revokes all keys when names is omitted.",
        input: {
          type: "object",
          properties: { names: { type: "array", items: { type: "string" } } },
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const { names } = input as { names?: string[] }
          const approved = approvedForSession.get(context.sessionID)
          if (names) names.forEach((name) => approved?.delete(name))
          else approvedForSession.delete(context.sessionID)
          const session = grants.get(context.sessionID)
          if (!session || session.size === 0) return { content: "Nothing was granted to this session." }
          const removed: string[] = []
          for (const [variable, grant] of session) {
            if (!names || names.includes(grant.name)) {
              session.delete(variable)
              removed.push(grant.name)
            }
          }
          return { content: removed.length ? `Revoked ${removed.join(", ")}.` : "No matching grants." }
        },
      })
    })

    // Shell hooks don't carry a session. Tag each shell tool call from a session with grants with a
    // one-time ID, and inject only into the shell that carries that tag; the tag is stripped again
    // before the command runs. Shells from other sessions, subagents or the user's `!` never match.
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "shell" || active(event.sessionID).length === 0) return
      const input = event.input as { command?: unknown } | null
      if (!input || typeof input.command !== "string") return
      const now = Date.now()
      for (const [tag, entry] of pending) if (now - entry.at > PENDING_MS) pending.delete(tag)
      const tag = randomUUID()
      pending.set(tag, { sessionID: event.sessionID, at: now })
      event.input = { ...input, command: `${input.command}\n# sek:${tag}` }
    })

    await ctx.shell.hook("create.before", (event) => {
      const match = TAG.exec(event.command)
      if (!match) return
      event.command = event.command.slice(0, match.index)
      const entry = pending.get(match[1]!)
      pending.delete(match[1]!)
      if (!entry) return
      for (const grant of active(entry.sessionID)) event.env[grant.env] = grant.value
    })

    await ctx.tool.hook("execute.after", (event) => {
      const secrets = redactions.get(event.sessionID)
      if (!secrets || secrets.size === 0) return
      if (event.status === "completed") {
        event.result = scrub(event.result, secrets)
      } else {
        const message = scrub(event.error.message, secrets)
        const metadata = scrub(event.error.metadata, secrets)
        if (message !== event.error.message || metadata !== event.error.metadata) {
          event.error = new ToolError({ ...event.error, message, metadata })
        }
      }
    })

    // Last line of defence: background shell output and the user's `!` shell reach the model
    // without a tool result, so scrub every model request too.
    await ctx.session.hook("context", (event) => {
      const secrets = redactions.get(event.sessionID)
      if (!secrets || secrets.size === 0) return
      event.messages = scrub(event.messages, secrets)
      event.system = scrub(event.system, secrets)
    })

    return () => {
      for (const pending of approvals.values()) pending.resolve("aborted")
      approvedForSession.clear()
      grants.clear()
      redactions.clear()
      pending.clear()
    }
  },
})
