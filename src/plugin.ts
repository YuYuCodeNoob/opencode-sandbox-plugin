import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import type { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { SandboxController } from "./controller"
import { SandboxRuntimeAdapter } from "./adapter"
import { SandboxPolicyStore } from "./policy-store"
import { TransparencyRepair, type V2ClientLike } from "./transparency"
import { PermissionBridge } from "./permission-bridge"
import { ViolationReporter } from "./violations"
import { decodeTuiCommand, encodeTuiCommand, type SandboxTuiCommand } from "./tui-protocol"
import type { SandboxManagerLike, SandboxStatus } from "./types"

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
 * - `event` + `tui.command.execute`: human-only control channel. The TUI plugin
 *   sends `sandbox.get/toggle/allow/deny` through `client.tui.publish`; the LLM
 *   cannot reach it. Sandbox enable/disable and network decisions are therefore
 *   not exposed as tools (no escape surface).
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

  /** Broadcast a protocol command to the TUI plugin over the SSE event bus. */
  const publishTui = (cmd: SandboxTuiCommand): void => {
    void client.tui.publish({
      body: { type: "tui.command.execute", properties: { command: encodeTuiCommand(cmd) } },
    })
  }
  const publishState = (s: SandboxStatus): void => {
    publishTui({
      v: 1,
      cmd: "sandbox.state",
      state: s.state,
      enabled: s.enabled,
      source: s.source,
      override: s.source === "override",
      activeChildren: s.activeChildren,
      pendingRefresh: s.pendingRefresh,
      lastError: s.lastError,
    })
  }

  let controller!: SandboxController
  const bridge = new PermissionBridge(client, {
    publish: publishTui,
    onAllowNetwork: (host, scope) => controller.allowNetwork(host, scope),
  })
  controller = new SandboxController({
    adapter,
    policyStore: store,
    onAsk: (req) => bridge.handleAsk(req),
    onStateChange: (s) => publishState(s),
  })

  const violationStore = (opts.manager as { getSandboxViolationStore?(): unknown }).getSandboxViolationStore?.()
  const violations = violationStore ? new ViolationReporter(client, violationStore as SandboxViolationStore) : null
  violations?.start()

  // Auto-enable when the effective default is on (runtimeOverride ?? enabledByDefault),
  // so a config of enabledByDefault: true actually activates the sandbox at startup.
  void store
    .effectiveEnabled()
    .then((enabled) => {
      if (enabled) return controller.enable().catch(() => {})
    })

  return {
    tool: {
      // Read-only status. Enable/disable/allow/deny are NOT exposed to the LLM —
      // those are human-only controls (TUI toggle + TUI network dialog).
      sandbox_status: tool({
        description: "Show sandbox state, effective policy source, pending network grants, and recent violations.",
        args: {},
        async execute() {
          const s = controller.status()
          const pending = bridge.pendingHosts()
          const recent = violations?.recent(10) ?? []
          const lines = [
            `State: ${s.state}`,
            `Enabled: ${s.enabled} (source: ${s.source})`,
            s.lastError ? `Last error: ${s.lastError.code} — ${s.lastError.message}` : null,
            `Active children: ${s.activeChildren}`,
            `Pending refresh: ${s.pendingRefresh}`,
            `Pending network grants: ${pending.map((p) => (p.port !== undefined ? `${p.host}:${p.port}` : p.host)).join(", ") || "none"}`,
            `Recent violations (${recent.length}): ${recent.map((v) => v.line).join(" | ") || "none"}`,
          ]
          return lines.filter((line): line is string => line !== null).join("\n")
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
      const ev = event as unknown as { type: string; properties: Record<string, any> }

      // 1) Human-only TUI control channel (tui.command.execute published by the
      //    TUI plugin via client.tui.publish). Unknown/foreign commands ignored.
      if (ev.type === "tui.command.execute") {
        const msg = decodeTuiCommand(ev.properties?.command)
        if (!msg) return
        switch (msg.cmd) {
          case "sandbox.get":
            publishState(controller.status())
            return
          case "sandbox.toggle": {
            // disabled → enable; error → retry enable; active/syncing → disable.
            const s = controller.status()
            try {
              if (s.state === "disabled" || s.state === "error") await controller.enable()
              else await controller.disable()
            } catch {
              // enable() is fail-closed; onStateChange already pushed the error state.
            }
            publishState(controller.status())
            return
          }
          case "sandbox.allow":
            bridge.resolve(msg.id, { allow: true, persist: msg.persist, scope: msg.scope })
            return
          case "sandbox.deny":
            bridge.resolve(msg.id, { allow: false })
            return
        }
        return
      }

      // 2) D7: auto-approve OpenCode's own bash permission for wrapped commands.
      if (ev.type !== "permission.asked") return
      if (!controller.isActive()) return
      const callID = ev.properties?.tool?.callID
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
