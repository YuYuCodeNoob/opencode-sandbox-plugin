/**
 * Sandbox TUI 插件 — 左下角入口 + 状态/授权弹窗（CLAUDE.md §9 / 控制权迁移）。
 *
 * 在 opencode 的 TUI 进程中加载（`~/.config/opencode/tui.json` 的 plugin 数组）。
 * 通信：
 *   - TUI → server：`tui.command.execute` 事件（`client.tui.publish`，已验证可达）
 *     —— sandbox.get / sandbox.toggle / sandbox.allow / sandbox.deny。
 *   - server → TUI：共享文件 `~/.config/opencode-sandbox/runtime.json`。
 *
 * 平台事实（编译版 opencode v1.17.20，已实测）：
 *   - `app_bottom` slot 的渲染是静态快照 —— SolidJS 信号/effect、toast、微型 dialog
 *     都不能触发它重渲染。因此左下角只放一个静态入口「Sandbox」，不显示实时状态。
 *   - `setInterval` 能跑、`api.ui.dialog.replace` 命令式弹窗可靠渲染 ——
 *     点击入口弹「当前状态 + 确认切换」对话框；网络授权弹窗用轮询 + 命令式弹窗。
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
import { onCleanup, onMount } from "solid-js"
import os from "node:os"
import path from "node:path"
import { readFileSync } from "node:fs"
import type { SandboxRuntime } from "../runtime-store"
import { encodeTuiCommand, type SandboxTuiCommand } from "../tui-protocol"

function runtimeFile(): string {
  return path.join(os.homedir(), ".config", "opencode-sandbox", "runtime.json")
}

/** 同步读共享 runtime 文件。 */
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

const ASK_DEBOUNCE_MS = 700

function SandboxWidget(props: { api: TuiPluginApi; theme: TuiThemeCurrent }): JSX.Element {
  const { api } = props

  const send = (cmd: SandboxTuiCommand): void => {
    void api.client.tui.publish({
      body: { type: "tui.command.execute", properties: { command: encodeTuiCommand(cmd) } },
    })
  }

  // 轮询共享文件：出现待决 ask 就命令式弹窗（网络授权）；状态变化弹 toast 反馈。
  onMount(() => {
    send({ v: 1, cmd: "sandbox.get" })
    let lastKey = ""
    let shownId: string | undefined // 当前已在弹窗中展示的 ask id（同一 id 绝不重弹）
    let pendingShowId: string | undefined // 正在防抖等待展示的 ask id
    let pendingTimer: ReturnType<typeof setTimeout> | undefined
    let ourDialog = false

    const clearPending = (): void => {
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = undefined
      pendingShowId = undefined
    }

    // 命令式弹窗展示一个 ask（Allow once / Always allow / Deny）。
    const showAsk = (ask: { id: string; host: string; port?: number | undefined }, total: number): void => {
      shownId = ask.id
      ourDialog = true
      const label = ask.port !== undefined ? `${ask.host}:${ask.port}` : ask.host
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
                send({ v: 1, cmd: "sandbox.allow", id: ask.id, host: ask.host, persist: false, scope: "global" })
              } else if (opt.value === "always") {
                send({ v: 1, cmd: "sandbox.allow", id: ask.id, host: ask.host, persist: true, scope: "global" })
              } else {
                send({ v: 1, cmd: "sandbox.deny", id: ask.id, host: ask.host })
              }
            }}
          />
        ),
        () => {
          ourDialog = false // 用户手动关闭：保持 shownId，不再对同一 ask 重弹
        },
      )
    }

    const timer = setInterval(() => {
      const r = readState()
      if (r) {
        const key = `${r.state}:${r.enabled}`
        if (key !== lastKey) {
          if (lastKey !== "") {
            api.ui.toast({
              title: "Sandbox",
              message: r.enabled ? `已启用 (${r.source})` : "已关闭",
              variant: r.state === "error" ? "error" : "info",
              duration: 1500,
            })
          }
          lastKey = key
        }
      }
      const asks = r?.asks ?? []
      const head = asks[0]
      const current = head?.id

      // 防抖：新 ask 出现时不立即弹，等一个窗口期收集突发（同一条 curl 的
      // redirect 链会产生多个 host 的 ask），再一次性弹队列头、显示 (1/N)。
      // 已展示的 id（shownId）与正在防抖的 id（pendingShowId）都不会重复调度。
      if (current && current !== shownId) {
        if (current !== pendingShowId) {
          pendingShowId = current
          if (pendingTimer) clearTimeout(pendingTimer)
          pendingTimer = setTimeout(() => {
            pendingTimer = undefined
            pendingShowId = undefined
            const latest = readState()
            const h = latest?.asks?.[0]
            if (h && h.id !== shownId) showAsk(h, (latest?.asks ?? []).length)
          }, ASK_DEBOUNCE_MS)
        }
      } else if (!current && pendingTimer) {
        clearPending()
      }
      if (!current && ourDialog) {
        ourDialog = false
        api.ui.dialog.clear()
      }
    }, 400)
    onCleanup(() => {
      clearInterval(timer)
      clearPending()
    })
  })

  // 点击入口 → 弹当前状态对话框（dialog 可靠渲染，状态永远准确）。
  const openToggleDialog = (): void => {
    const r = readState()
    const stateMsg = r ? (r.enabled ? `已启用 (${r.source})` : "已关闭") : "未知"
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogConfirm
          title="Sandbox"
          message={`当前状态：${stateMsg}。确认切换？`}
          onConfirm={() => {
            api.ui.dialog.clear()
            send({ v: 1, cmd: "sandbox.toggle" })
          }}
          onCancel={() => {
            api.ui.dialog.clear()
          }}
        />
      ),
      () => {},
    )
  }

  return (
    <box paddingX={1} onMouseUp={openToggleDialog}>
      <text style={{ fg: props.theme.text }}>Sandbox</text>
    </box>
  )
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const slot: TuiSlotPlugin = {
    order: -1000,
    slots: {
      sidebar_content(ctx: TuiSlotContext) {
        return <SandboxWidget api={api} theme={ctx.theme.current} />
      },
      home_bottom(ctx: TuiSlotContext) {
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
