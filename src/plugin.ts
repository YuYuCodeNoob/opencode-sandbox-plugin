import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import type { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { SandboxController } from "./controller"
import { SandboxRuntimeAdapter } from "./adapter"
import { SandboxPolicyStore } from "./policy-store"
import { TransparencyRepair, type V2ClientLike } from "./transparency"
import { PermissionBridge } from "./permission-bridge"
import { ViolationReporter } from "./violations"
import type { SandboxManagerLike } from "./types"

export interface SandboxPluginOptions {
  manager: SandboxManagerLike
  globalConfigPath: string
  projectConfigPath: string
  /** Injectable v2 client (defaults to one constructed from the plugin input). */
  client?: V2ClientLike
}

/**
 * Construct a v2 SDK client pointed at the same OpenCode server the plugin is
 * running in. `input.client` is the legacy SDK client and lacks the permission
 * create/reply and session part-update APIs the sandbox needs, so we build the
 * v2 client ourselves. Auth mirrors ServerAuth.headers(): Basic auth only when
 * OPENCODE_SERVER_PASSWORD is set.
 */
export function createV2Client(input: PluginInput): V2ClientLike {
  const baseUrl = input.serverUrl?.toString() ?? "http://localhost:4096"
  const password = process.env.OPENCODE_SERVER_PASSWORD
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  const headers = password
    ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
    : undefined
  return createOpencodeClient({
    baseUrl,
    directory: input.directory,
    ...(headers ? { headers } : {}),
  }) as unknown as V2ClientLike
}

/**
 * Wire the sandbox into an OpenCode plugin (CLAUDE.md §6).
 *
 * - `tool.execute.before` (bash): rewrite `args.command` to the SRT-wrapped
 *   command (real spawn); disabled → baseline execution; enabled-but-not-active
 *   → throw (fail-closed).
 * - `tool.execute.after`: restore the original command in the stored part
 *   (transparency) and set the display/LLM title back to the original.
 * - `event` + `permission.asked` + v2 `permission.reply`: D7 permission
 *   takeover. The `permission.ask` hook is declared by the plugin API but never
 *   invoked by current OpenCode; instead we auto-reply "once" to permission
 *   requests for callIDs we wrapped, so bash runs without a TUI prompt while
 *   the sandbox policy (not OpenCode's bash permission) is the authority.
 */
export function createSandboxPlugin(input: PluginInput, opts: SandboxPluginOptions): Hooks {
  const client = opts.client ?? createV2Client(input)
  const store = new SandboxPolicyStore({
    globalPath: opts.globalConfigPath,
    projectPath: opts.projectConfigPath,
  })
  const adapter = new SandboxRuntimeAdapter(opts.manager, { cwd: input.directory })
  const transparency = new TransparencyRepair()
  const bridge = new PermissionBridge(client)
  const controller = new SandboxController({
    adapter,
    policyStore: store,
    onAsk: (req) => bridge.handleAsk(req),
  })

  const violationStore = (opts.manager as { getSandboxViolationStore?(): unknown }).getSandboxViolationStore?.()
  const violations = violationStore ? new ViolationReporter(client, violationStore as SandboxViolationStore) : null
  violations?.start()

  return {
    tool: {
      sandbox_status: tool({
        description: "Show sandbox state, effective policy summary, pending network grants, and recent violations.",
        args: {},
        async execute() {
          const s = controller.status()
          const pending = bridge.pendingHosts()
          const recent = violations?.recent(10) ?? []
          const lines = [
            `State: ${s.state}`,
            `Enabled: ${s.enabled}`,
            s.lastError ? `Last error: ${s.lastError.code} — ${s.lastError.message}` : null,
            `Active children: ${s.activeChildren}`,
            `Pending refresh: ${s.pendingRefresh}`,
            `Pending network grants: ${pending.map((p) => (p.port !== undefined ? `${p.host}:${p.port}` : p.host)).join(", ") || "none"}`,
            `Recent violations (${recent.length}): ${recent.map((v) => v.line).join(" | ") || "none"}`,
          ]
          return lines.filter((line): line is string => line !== null).join("\n")
        },
      }),

      sandbox_enable: tool({
        description: "Enable the sandbox for this session (fail-closed: bash is blocked until active).",
        args: {},
        async execute() {
          try {
            await controller.enable()
            return `Sandbox enabled. State: ${controller.status().state}`
          } catch (e) {
            return `Failed to enable sandbox: ${(e as Error).message}`
          }
        },
      }),

      sandbox_disable: tool({
        description: "Disable the sandbox for this session (bash returns to unsandboxed execution).",
        args: {},
        async execute() {
          await controller.disable()
          return `Sandbox disabled.`
        },
      }),

      sandbox_allow: tool({
        description:
          "Allow a network domain in the sandbox. Applies immediately to a pending connection for that host and to all future connections.",
        args: { host: tool.schema.string(), scope: tool.schema.enum(["project", "global"]).optional() },
        async execute(args) {
          const host = args.host
          const scope = args.scope ?? "global"
          try {
            await controller.allowNetwork(host, scope)
          } catch (e) {
            return `Failed to update sandbox policy: ${(e as Error).message}`
          }
          const resolved = bridge.allow(host)
          return resolved
            ? `Allowed ${host} (${scope}). A pending request was approved — the blocked connection may now proceed.`
            : `Allowed ${host} (${scope}). Policy updated for future connections; no request was pending.`
        },
      }),

      sandbox_deny: tool({
        description: "Deny a network domain in the sandbox (takes precedence over allow).",
        args: { host: tool.schema.string(), scope: tool.schema.enum(["project", "global"]).optional() },
        async execute(args) {
          const host = args.host
          const scope = args.scope ?? "global"
          await controller.denyNetwork(host, scope)
          bridge.deny(host)
          return `Denied ${host} (${scope}).`
        },
      }),
    },
    async "tool.execute.before"({ tool, sessionID, callID }, output) {
      if (tool !== "bash") return
      if (!controller.isEnabled()) return // disabled → baseline execution
      const original = String(output.args.command ?? "")
      controller.ensureExecutable() // fail-closed: throws unless active
      transparency.register(callID, original)
      output.args.command = await controller.beforeSpawn(sessionID, callID, original)
    },

    async "tool.execute.after"({ tool, sessionID, callID }, output) {
      if (tool !== "bash") return
      const original = transparency.peekOriginal(callID)
      if (original !== undefined) output.title = original
      await transparency.repair(client, sessionID, callID)
      controller.afterSpawn(callID)
    },

    async event({ event }) {
      // The plugin API's Event union predates "permission.asked"; treat it dynamically.
      const ev = event as unknown as {
        type: string
        properties: { id: string; tool?: { callID?: string } }
      }
      if (ev.type !== "permission.asked") return
      if (!controller.isActive()) return
      const callID = ev.properties.tool?.callID
      if (typeof callID === "string" && transparency.hasWrapped(callID)) {
        // v1 reply endpoint (/permission/{requestID}/reply) resolves the in-process
        // request the bash tool created via ctx.ask.
        await client.permission.reply({ requestID: ev.properties.id, reply: "once" })
      }
    },

    async dispose() {
      await controller.dispose()
    },
  }
}
