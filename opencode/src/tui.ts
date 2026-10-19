import { Plugin } from "@opencode/plugin/tui"
import { Sek, type Decision } from "./rpc.js"

/**
 * Shows an approval dialog whenever an agent calls `sek_request`, one request at a time.
 * Deny is preselected, and Escape (or anything else that closes the dialog) denies.
 */

type Request = {
  requestID: string
  sessionID: string
  names: string[]
  reason: string
  location: { directory: string }
}

export default Plugin.define({
  id: "sek.tui",
  setup(ctx) {
    const sek = ctx.client.rpc(Sek)
    const queue: Request[] = []
    /** Requests that ended elsewhere (another TUI, headless fallback); their dialog closes without a decision. */
    const ended = new Set<string>()
    let showing: string | undefined

    const describe = (request: Request) => {
      const session = ctx.data.session.get(request.sessionID) as { title?: string } | undefined
      return `${session?.title ?? request.sessionID} · ${ctx.ui.format.path(request.location.directory)}`
    }

    const end = (requestID: string) => {
      const index = queue.findIndex((request) => request.requestID === requestID)
      if (index >= 0) queue.splice(index, 1)
      if (showing === requestID) {
        ended.add(requestID)
        ctx.ui.dialog.clear()
      }
    }

    const pump = async () => {
      if (showing) return
      const request = queue.shift()
      if (!request) return
      showing = request.requestID
      const keys = request.names.join(", ")
      const decision = await ctx.ui.dialog.select<Decision>({
        title: `Agent wants ${keys}`,
        current: "deny",
        options: [
          { title: "Deny", value: "deny" },
          { title: "Allow once", value: "once", description: `agent says: ${request.reason}` },
          { title: "Allow for this session", value: "session", description: describe(request) },
        ],
      })
      showing = undefined
      if (!ended.delete(request.requestID)) {
        const answer = decision ?? "deny"
        const result = await sek
          .decide({ requestID: request.requestID, decision: answer }, { location: request.location })
          .catch(() => undefined)
        const accepted = (result as { ok?: boolean } | undefined)?.ok === true
        ctx.ui.toast.show(
          !accepted
            ? { message: `sek: the request for ${keys} had already ended`, variant: "warning", duration: 4000 }
            : {
                message:
                  answer === "deny"
                    ? `Denied ${keys}`
                    : `Allowed ${keys}${answer === "session" ? " for this session" : " once"}`,
                variant: answer === "deny" ? "warning" : "success",
                duration: 3000,
              },
        )
      }
      void pump()
    }

    // ctx.data.listen rides the TUI's own server connection, which reconnects after sleep or a
    // server restart; a plain RPC event subscription would stop silently after one drop.
    const stop = ctx.data.listen(({ details }) => {
      const event = details as unknown as { type: string; data: unknown; location: { directory: string } }
      if (event.type === "rpc.sek.requested") {
        const request = { ...(event.data as Omit<Request, "location">), location: event.location }
        queue.push(request)
        // Tell the server a person is watching, so it waits for the answer instead of going headless.
        void sek
          .ack({ requestID: request.requestID }, { location: event.location })
          .then((result) => {
            if ((result as { ok?: boolean }).ok !== true) end(request.requestID)
          })
          .catch(() => end(request.requestID))
        void pump()
      } else if (event.type === "rpc.sek.resolved") {
        end((event.data as { requestID: string }).requestID)
      }
    })

    return stop
  },
})
