/**
 * Sandbox TUI ↔ server 协议（CLAUDE.md §7 变体 / 控制权迁移）。
 *
 * 服务端插件与 TUI 插件通过 opencode 的 `tui.command.execute` 事件双向通信：
 * 任一侧调用 `client.tui.publish({ body: { type: "tui.command.execute",
 * properties: { command: <JSON> } } })`，事件经 EventV2/SSE 广播，两侧都能收到。
 * 原生 TUI 对未知 command 静默 no-op，因此该通道不经过任何 tool / LLM。
 *
 * command 字段内是紧凑 JSON，`v` 为协议版本，未知 `cmd` 一律忽略。
 */

import type { SandboxError, SandboxState } from "./types"

export type SandboxTuiCommand =
  // ── TUI → server ─────────────────────────────────────────────
  /** 挂载时拉取当前沙箱状态（server 回 sandbox.state）。 */
  | { v: 1; cmd: "sandbox.get" }
  /** 左下角开关：enable ⇄ disable（每进程 runtime override）。 */
  | { v: 1; cmd: "sandbox.toggle" }
  /** 网络授权：persist=false 仅放行当前连接；persist=true 同时写入 allowlist。 */
  | { v: 1; cmd: "sandbox.allow"; id: string; host: string; persist: boolean; scope: "global" | "project" }
  /** 网络拒绝：resolve 为 false，当前连接拒绝。 */
  | { v: 1; cmd: "sandbox.deny"; id: string; host: string }
  // ── server → TUI ─────────────────────────────────────────────
  /** 状态推送：任意状态变更 / 响应 sandbox.get。 */
  | {
      v: 1
      cmd: "sandbox.state"
      state: SandboxState
      enabled: boolean
      source: "config" | "override"
      override: boolean
      activeChildren: number
      pendingRefresh: boolean
      lastError?: SandboxError | null
    }
  /** 网络授权请求（SRT askCallback 阻塞连接等待人决策）。 */
  | { v: 1; cmd: "sandbox.ask"; id: string; host: string; port?: number; timeoutMs: number }
  /** ask 已解决（含超时自动拒绝）→ TUI 关闭对应对话框。 */
  | { v: 1; cmd: "sandbox.ask.resolved"; id: string; allowed: boolean }

const KNOWN_CMDS = new Set<string>([
  "sandbox.get",
  "sandbox.toggle",
  "sandbox.allow",
  "sandbox.deny",
  "sandbox.state",
  "sandbox.ask",
  "sandbox.ask.resolved",
])

export function encodeTuiCommand(cmd: SandboxTuiCommand): string {
  return JSON.stringify(cmd)
}

/** Parse a `tui.command.execute` command payload; returns undefined for anything not ours. */
export function decodeTuiCommand(raw: string): SandboxTuiCommand | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const msg = parsed as Record<string, unknown>
  if (msg.v !== 1) return undefined
  if (typeof msg.cmd !== "string" || !KNOWN_CMDS.has(msg.cmd)) return undefined
  return parsed as SandboxTuiCommand
}
