/**
 * Sandbox TUI 插件 — 左下角开关 + 网络授权弹窗（CLAUDE.md §9 / 控制权迁移）。
 *
 * 在 opencode 的 TUI 进程中加载（`~/.config/opencode/tui.json` 的 plugin 数组）。
 * 通信：
 *   - TUI → server：`tui.command.execute` 事件（`client.tui.publish`，已验证可达）
 *     —— sandbox.get / sandbox.toggle / sandbox.allow / sandbox.deny。
 *   - server → TUI：共享文件 `~/.config/opencode-sandbox/runtime.json`。
 *
 * 平台事实（编译版 opencode v1.17.20）：
 *   - `app_bottom` slot 的渲染是静态快照 —— SolidJS 信号/effect 不会触发重渲染，
 *     因此开关状态在每次 TUI 重绘时同步读文件。
 *   - `setInterval` 在插件里能跑、`api.ui.dialog.replace` 命令式弹窗有效 ——
 *     网络授权弹窗用轮询 + 命令式弹窗实现。
 *
 * 控制权在 TUI（人），不暴露给 LLM。
 */

import type { JSX } from "@opentui/solid"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiSlotPlugin,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, onMount } from "solid-js"
import os from "node:os"
import path from "node:path"
import { readFileSync } from "node:fs"
import type { SandboxRuntime } from "../runtime-store"
import { encodeTuiCommand, type SandboxTuiCommand } from "../tui-protocol"

function runtimeFile(): string {
  return path.join(os.homedir(), ".config", "opencode-sandbox", "runtime.json")
}

/** 同步读共享 runtime 文件（slot 每次重绘调用）。 */
function readState(): SandboxRuntime | null {
  try {
    const raw = readFileSync(runtimeFile(), "utf-8")
    const parsed = JSON.parse(raw) as Partial<SandboxRuntime>
    if (parsed && typeof parsed.state === "string") {
      return {
        state: parsed.state,
        enabled: parsed.enabled ?? false,
        source: parsed.source === "override" ? "override" : "config",
        override: parsed.override ?? false,
        activeChildren: parsed.activeChildren ?? 0,
        pendingRefresh: parsed.pendingRefresh ?? false,
        lastError: parsed.lastError ?? null,
        asks: Array.isArray(parsed.asks) ? parsed.asks : [],
      }
    }
  } catch {
    /* file absent / not yet written */
  }
  return null
}

function toggleLabel(
  r: SandboxRuntime | null,
  pal: {
    on: TuiThemeCurrent["success"]
    off: TuiThemeCurrent["textMuted"]
    warn: TuiThemeCurrent["warning"]
    err: TuiThemeCurrent["error"]
    text: TuiThemeCurrent["text"]
  },
): { label: string; fg: TuiThemeCurrent["success"] } {
  // 不用 <span> 直接放 <box> 里（该环境下不渲染），避免 U+1F6E1 🛡 等缺字形 emoji。
  if (!r) return { label: "▣ …", fg: pal.text }
  switch (r.state) {
    case "error":
      return { label: "▣ ERR", fg: pal.err }
    case "initializing":
    case "pending-refresh":
      return { label: "▣ …", fg: pal.warn }
    default:
      if (r.enabled) return { label: r.override ? "▣ ON*" : "▣ ON", fg: pal.on }
      return { label: r.override ? "▣ OFF*" : "▣ OFF", fg: pal.off }
  }
}

function SandboxWidget(props: { api: TuiPluginApi; theme: TuiThemeCurrent }): JSX.Element {
  const { api } = props
  const [, setTick] = createSignal(0)

  const send = (cmd: SandboxTuiCommand): void => {
    void api.client.tui.publish({
      body: { type: "tui.command.execute", properties: { command: encodeTuiCommand(cmd) } },
    })
  }

  // 轮询共享文件：出现待决 ask 就命令式弹窗（slot 静态渲染不影响弹窗）。
  onMount(() => {
    send({ v: 1, cmd: "sandbox.get" })
    let shownId: string | undefined
    let ourDialog = false
    const timer = setInterval(() => {
      const head = readState()?.asks?.[0]
      const current = head?.id
      if (current && current !== shownId) {
        shownId = current
        ourDialog = true
        const label = head.port !== undefined ? `${head.host}:${head.port}` : head.host
        const total = (readState()?.asks ?? []).length
        api.ui.dialog.replace(
          () => (
            <api.ui.DialogSelect
              title={total > 1 ? `Sandbox 网络授权 (1/${total})` : "Sandbox 网络授权"}
              placeholder={`↑/↓ 选择，Enter 确认 · ${label}`}
              options={[
                { title: "Allow once", value: "once", description: `仅放行当前连接：${label}` },
                { title: "Always allow", value: "always", description: `写入全局 allowlist：${label}` },
                { title: "Deny", value: "deny", description: `拒绝：${label}` },
              ]}
              onSelect={(opt) => {
                ourDialog = false
                api.ui.dialog.clear()
                if (opt.value === "once") {
                  send({ v: 1, cmd: "sandbox.allow", id: head.id, host: head.host, persist: false, scope: "global" })
                } else if (opt.value === "always") {
                  send({ v: 1, cmd: "sandbox.allow", id: head.id, host: head.host, persist: true, scope: "global" })
                } else {
                  send({ v: 1, cmd: "sandbox.deny", id: head.id, host: head.host })
                }
              }}
            />
          ),
          () => {
            ourDialog = false // 用户手动关闭：保持 shownId，不再对同一 ask 重弹
          },
        )
      } else if (!current && ourDialog) {
        ourDialog = false
        api.ui.dialog.clear()
      }
    }, 400)
    onCleanup(() => clearInterval(timer))
  })

  // slot 渲染：每次 TUI 重绘时同步读文件（静态快照，随重绘刷新）。
  const r = readState()
  const pal = toggleLabel(r, {
    on: props.theme.success,
    off: props.theme.textMuted,
    warn: props.theme.warning,
    err: props.theme.error,
    text: props.theme.text,
  })
  return (
    <box
      paddingX={1}
      onMouseUp={() => {
        send({ v: 1, cmd: "sandbox.toggle" })
        setTick((n) => n + 1) // 提示后续重绘时刷新
      }}
    >
      <text style={{ fg: pal.fg }}>{pal.label}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const slot: TuiSlotPlugin = {
    order: -1000, // 最左：app_bottom 是底部全宽 bar，低 order 渲染在最前
    slots: {
      app_bottom(ctx: TuiSlotContext) {
        return <SandboxWidget api={api} theme={ctx.theme.current} />
      },
    },
  }
  api.slots.register(slot)

  // 键盘回退：/sandbox-toggle 斜杠命令。
  api.command?.register(() => [
    {
      title: "Sandbox: Toggle",
      value: "sandbox.toggle",
      description: "Enable or disable the sandbox for this OpenCode process",
      slash: { name: "sandbox-toggle" },
      onSelect: () => {
        void api.client.tui.publish({
          body: { type: "tui.command.execute", properties: { command: encodeTuiCommand({ v: 1, cmd: "sandbox.toggle" }) } },
        })
      },
    },
  ])
}

const mod: TuiPluginModule & { id: string } = {
  id: "opencode-sandbox-plugin",
  tui,
}

export default mod
