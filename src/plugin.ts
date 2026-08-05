import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import type { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { SandboxController } from "./controller"
import { SandboxRuntimeAdapter } from "./adapter"
import { SandboxPolicyStore } from "./policy-store"
import { TransparencyRepair, type V2ClientLike } from "./transparency"
import { PermissionBridge } from "./permission-bridge"
import { ViolationReporter } from "./violations"
import { decodeTuiCommand } from "./tui-protocol"
import { runtimePathFor, writeRuntime } from "./runtime-store"
import { debugLog } from "./debug"
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
 *
 * NOTE: in compiled opencode deployments `input.serverUrl` may fall back to
 * `http://localhost:4096` (no real server there) — calls made through this
 * client are best-effort and wrapped in timeouts by the caller.
 */
export function createV2Client(input: PluginInput): V2ClientLike {
  const baseUrl = input.serverUrl?.toString() ?? "http://localhost:4096"
  const password = process.env.OPENCODE_SERVER_PASSWORD
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  const headers = password
    ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
    : undefined
  debugLog("createV2Client:baseUrl", baseUrl)

  // 编译版 opencode（TUI + server 同进程）里 `Server.url` 为 undefined，
  // serverUrl 回退到 localhost:4096（死端口，HTTP 调用会挂起）。opencode 给
  // `input.client`（v1 SDK）注入了**进程内 fetch**（`Server.Default().app.fetch`，
  // 直达本进程 HTTP handler），但 v1 SDK 缺 part 端点。把该 fetch 借给 v2 client，
  // part.update / session.message 就能在进程内直达 server。
  const inProcessFetch = extractInProcessFetch(input.client)
  debugLog("createV2Client:fetch", inProcessFetch ? "in-process" : "http")
  return createOpencodeClient({
    baseUrl,
    directory: input.directory,
    // `Server.Default().app.fetch` 签名是 `(req: Request) => Promise<Response>`，
    // 比全局 fetch 窄；SDK 运行时只调用 `fetch(request)`，类型上做一次收窄转换。
    ...(inProcessFetch ? { fetch: inProcessFetch as unknown as typeof fetch } : {}),
    ...(headers ? { headers } : {}),
  }) as unknown as V2ClientLike
}

/**
 * 从 legacy `input.client`（v1 SDK，由 opencode 用进程内 fetch 构建）里取出
 * 底层 `createClient` 的 fetch。v1 SDK 缺 part 端点，v2 client 需要同样的传输。
 * 取不到时返回 undefined（回退普通 HTTP，测试/mock 场景）。
 */
function extractInProcessFetch(client: unknown): ((req: Request) => Promise<Response>) | undefined {
  try {
    const raw = (client as { _client?: { getConfig?: () => { fetch?: unknown } } })?._client
    const fetch = raw?.getConfig?.().fetch
    return typeof fetch === "function" ? (fetch as (req: Request) => Promise<Response>) : undefined
  } catch {
    return undefined
  }
}

/** Resolve after `ms` or reject with a timeout error, whichever comes first. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
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
 * - Shared runtime file (`~/.config/opencode-sandbox/runtime.json`): the server
 *   writes state + pending asks; the TUI plugin polls it. This is the server→TUI
 *   channel (the SSE event direction is unreliable in compiled deployments).
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
  const runtimeFile = runtimePathFor(opts.globalConfigPath)

  let controller!: SandboxController
  let refreshRuntime: () => void = () => {}
  const bridge = new PermissionBridge(client, {
    onAllowNetwork: (host, scope) => controller.allowNetwork(host, scope),
    onAskChange: () => refreshRuntime(),
  })
  controller = new SandboxController({
    adapter,
    policyStore: store,
    onAsk: (req) => bridge.handleAsk(req),
    onStateChange: () => refreshRuntime(),
  })
  refreshRuntime = () => {
    const s: SandboxStatus = controller.status()
    void writeRuntime(runtimeFile, {
      state: s.state,
      enabled: s.enabled,
      source: s.source,
      override: s.source === "override",
      activeChildren: s.activeChildren,
      pendingRefresh: s.pendingRefresh,
      lastError: s.lastError,
      asks: bridge.pendingAsks(),
    })
  }

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
    .finally(() => refreshRuntime()) // 初始状态先写一次，TUI 首次渲染即可读到

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
      // 修复 part 的 state.input.command（透明抽象）。不阻塞 bash：HTTP 的
      // 定位+回写比 tool-result → completeToolCall 慢，稍作延迟让后者先把
      // part 置为 completed，修复再读已完成 part 并原样保留其 status。
      const messageID = transparency.peekMessageID(callID)
      setTimeout(() => {
        void withTimeout(transparency.repair(client, sessionID, callID, messageID), 5000).catch(() => {})
      }, 250)
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
            refreshRuntime()
            return
          case "sandbox.toggle": {
            // disabled → enable; error → retry enable; active/syncing → disable.
            try {
              const s = controller.status()
              if (s.state === "disabled" || s.state === "error") await controller.enable()
              else await controller.disable()
            } catch {
              // enable() is fail-closed; onStateChange already refreshed the runtime file.
            }
            refreshRuntime()
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
      const toolInfo = ev.properties?.tool
      const callID = typeof toolInfo?.callID === "string" ? toolInfo.callID : undefined
      if (callID && transparency.hasWrapped(callID)) {
        // 记录所在 messageID（tool.execute.after 用它做定向 part 定位，避免全量扫描）
        if (typeof toolInfo?.messageID === "string") transparency.registerMessageID(callID, toolInfo.messageID)
        // v1 reply endpoint (/permission/{requestID}/reply) resolves the in-process
        // request the bash tool created via ctx.ask.
        await withTimeout(
          client.permission.reply({ requestID: ev.properties.id, reply: "once" }),
          3000,
        ).catch(() => {})
      }
    },

    async dispose() {
      await controller.dispose()
    },
  }
}
