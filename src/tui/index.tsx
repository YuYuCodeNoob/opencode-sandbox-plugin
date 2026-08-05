/**
 * Sandbox TUI 插件 — 左下角开关 + 网络授权弹窗（CLAUDE.md §9 / 控制权迁移）。
 *
 * 在 opencode 的 TUI 进程中加载（`~/.config/opencode/tui.jsonc` 的 plugin 数组）。
 * 与服务端插件通过 `tui.command.execute` 事件双向通信（`client.tui.publish`）：
 *   - 左下角 `app_bottom` slot 渲染沙箱开关（ON / ON星号 / OFF / OFF星号 / ERROR），点击切换；
 *   - 收到 `sandbox.ask` 时弹出三选（Allow once / Always allow / Deny）；
 *   - 决策发回服务端，不经过任何 tool / LLM。
 *
 * JSX 转换：tsconfig `jsxImportSource: "@opentui/solid"`（类型）+ build.tui.mjs
 * esbuild-plugin-solid（打包）。
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
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { decodeTuiCommand, encodeTuiCommand, type SandboxTuiCommand } from "../tui-protocol"

type StateMsg = Extract<SandboxTuiCommand, { cmd: "sandbox.state" }>
type AskMsg = Extract<SandboxTuiCommand, { cmd: "sandbox.ask" }>

function toggleLabel(
  s: StateMsg | null,
  pal: {
    on: TuiThemeCurrent["success"]
    off: TuiThemeCurrent["textMuted"]
    warn: TuiThemeCurrent["warning"]
    err: TuiThemeCurrent["error"]
    text: TuiThemeCurrent["text"]
  },
): { label: string; fg: TuiThemeCurrent["success"] } {
  if (!s) return { label: "🛡 …", fg: pal.text }
  switch (s.state) {
    case "error":
      return { label: "🛡 ERROR", fg: pal.err }
    case "initializing":
    case "pending-refresh":
      return { label: "🛡 …", fg: pal.warn }
    default:
      if (s.enabled) return { label: s.override ? "🛡 ON*" : "🛡 ON", fg: pal.on }
      return { label: s.override ? "🛡 OFF*" : "🛡 OFF", fg: pal.off }
  }
}

function SandboxWidget(props: { api: TuiPluginApi; theme: TuiThemeCurrent }): JSX.Element {
  const { api } = props
  const [status, setStatus] = createSignal<StateMsg | null>(null)
  const [asks, setAsks] = createSignal<AskMsg[]>([])
  let ourDialogOpen = false

  const send = (cmd: SandboxTuiCommand): void => {
    void api.client.tui.publish({
      body: { type: "tui.command.execute", properties: { command: encodeTuiCommand(cmd) } },
    })
  }

  // 挂载时拉一次当前状态（服务端回 sandbox.state）。
  onMount(() => send({ v: 1, cmd: "sandbox.get" }))

  const off = api.event.on("tui.command.execute", (evt) => {
    const msg = decodeTuiCommand(evt.properties.command)
    if (!msg) return
    switch (msg.cmd) {
      case "sandbox.state":
        setStatus(msg)
        break
      case "sandbox.ask":
        setAsks((prev) => (prev.some((a) => a.id === msg.id) ? prev : [...prev, msg]))
        break
      case "sandbox.ask.resolved":
        setAsks((prev) => prev.filter((a) => a.id !== msg.id))
        break
    }
  })
  onCleanup(off)

  // 队列头渲染网络授权弹窗；解决后展示下一个或关闭。
  createEffect(() => {
    const queue = asks()
    const head = queue[0]
    if (!head) {
      if (ourDialogOpen) {
        api.ui.dialog.clear()
        ourDialogOpen = false
      }
      return
    }
    if (api.ui.dialog.open && !ourDialogOpen) return // 栈上已有其他弹窗，本次等待超时自动拒绝
    ourDialogOpen = true
    const label = head.port !== undefined ? `${head.host}:${head.port}` : head.host
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogSelect
          title={queue.length > 1 ? `Sandbox 网络授权 (1/${queue.length})` : "Sandbox 网络授权"}
          placeholder={`↑/↓ 选择，Enter 确认 · ${label}`}
          options={[
            { title: "Allow once", value: "once", description: `仅放行当前连接：${label}` },
            { title: "Always allow", value: "always", description: `写入全局 allowlist：${label}` },
            { title: "Deny", value: "deny", description: `拒绝：${label}` },
          ]}
          onSelect={(opt) => {
            setAsks((prev) => prev.filter((a) => a.id !== head.id))
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
        ourDialogOpen = false
      },
    )
  })

  const pal = toggleLabel(status(), {
    on: props.theme.success,
    off: props.theme.textMuted,
    warn: props.theme.warning,
    err: props.theme.error,
    text: props.theme.text,
  })
  return (
    <box paddingX={1} onMouseUp={() => send({ v: 1, cmd: "sandbox.toggle" })}>
      <span style={{ fg: pal.fg }}>{pal.label}</span>
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
