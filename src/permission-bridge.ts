/**
 * PermissionBridge — 网络授权桥（CLAUDE.md §7，TUI 弹窗变体）
 *
 * SRT `sandboxAskCallback` 在沙箱命令访问未配置 host 时阻塞连接并等待
 * `Promise<boolean>`。本桥把一次阻塞等待表面化成一个 `sandbox.ask` 事件
 * （经 `tui.command.execute` 推给 TUI 插件渲染弹窗）+ toast 回退：
 * 用户在 TUI 弹窗中选择 Allow once / Always allow / Deny，TUI 通过
 * `tui.command.execute` 发回决策，桥据此 resolve 等待中的回调
 * （true → 当前连接立即放行），否则超时后默认拒绝。
 *
 * 决策不经过任何 tool / LLM，只有 TUI（人）可以发起。
 */

import { encodeTuiCommand, type SandboxTuiCommand } from "./tui-protocol"
import type { RuntimeAsk } from "./runtime-store"
import type { AskRequest } from "./types"
import type { V2ClientLike } from "./transparency"

interface Pending {
  id: string
  host: string
  port: number | undefined
  expiresAt: number
  resolvers: Array<(allowed: boolean) => void>
  timer: ReturnType<typeof setTimeout>
}

export type NetworkDecision = {
  allow: boolean
  /** true → 放行当前连接 + 写入 allowlist（Always allow）；false → 仅放行当前连接。 */
  persist?: boolean
  scope?: "project" | "global"
}

export interface PermissionBridgeOptions {
  timeoutMs?: number
  toast?: boolean
  /** 把协议命令发给 TUI（经 client.tui.publish；部分部署下 server→TUI 事件不可达，仅作尽力）。 */
  publish?: (cmd: SandboxTuiCommand) => void
  /** persist=true 时持久化网络策略（controller.allowNetwork）。 */
  onAllowNetwork?: (host: string, scope: "project" | "global") => void | Promise<void>
  /** 待决 ask 集合变化（新增/解决/超时）时回调，用于刷新共享 runtime 文件。 */
  onAskChange?: () => void
}

const DEFAULT_TIMEOUT_MS = 15_000

export class PermissionBridge {
  private pending = new Map<string, Pending>()

  constructor(
    private readonly client: V2ClientLike,
    private readonly opts: PermissionBridgeOptions = {},
  ) {}

  getPendingCount(): number {
    return this.pending.size
  }

  /** Hosts currently awaiting a decision (for sandbox_status). */
  pendingHosts(): Array<{ host: string; port: number | undefined }> {
    return [...this.pending.values()].map((p) => ({ host: p.host, port: p.port }))
  }

  /** Pending asks with ids + expiry (for the shared runtime file the TUI polls). */
  pendingAsks(): RuntimeAsk[] {
    return [...this.pending.values()].map((p) => ({ id: p.id, host: p.host, port: p.port, expiresAt: p.expiresAt }))
  }

  /**
   * Called by the controller's askCallback. Returns a promise that stays
   * pending until the TUI resolves it (→ current connection proceeds) or the
   * timeout elapses (→ denied). Same-host concurrency shares one ask.
   */
  handleAsk(req: AskRequest): Promise<boolean> {
    const key = req.host
    const existing = this.pending.get(key)
    if (existing) {
      return new Promise<boolean>((resolve) => existing.resolvers.push(resolve))
    }
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const entry: Pending = {
      id: crypto.randomUUID(),
      host: req.host,
      port: req.port,
      expiresAt: Date.now() + timeoutMs,
      resolvers: [],
      timer: setTimeout(() => this.settle(key, false), timeoutMs),
    }
    this.pending.set(key, entry)
    this.opts.onAskChange?.()
    this.opts.publish?.({ v: 1, cmd: "sandbox.ask", id: entry.id, host: entry.host, port: entry.port, timeoutMs })
    if (this.opts.toast ?? true) {
      const label = req.port !== undefined ? `${req.host}:${req.port}` : req.host
      const seconds = Math.round(timeoutMs / 1000)
      // Best-effort: the toast is a fallback notification; in deployments where the
      // server→TUI HTTP path hangs, the timeout keeps it from leaking a request.
      Promise.race([
        this.client.tui.showToast({
          title: "Sandbox network access",
          message: `"${label}" is not in the network allowlist. Waiting for your decision in the TUI (${seconds}s).`,
          variant: "warning",
          duration: timeoutMs + 5_000,
        }),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]).catch(() => {})
    }
    return new Promise<boolean>((resolve) => entry.resolvers.push(resolve))
  }

  /**
   * Resolve a pending ask by id (from the TUI decision). `persist` triggers the
   * allowlist write (Always allow) after unblocking the current connection.
   * Returns false if no pending ask matched (e.g. already timed out).
   */
  resolve(id: string, decision: NetworkDecision): boolean {
    const entry = [...this.pending.values()].find((p) => p.id === id)
    if (!entry) return false
    this.settle(entry.host, decision.allow)
    if (decision.allow && decision.persist) {
      void this.opts.onAllowNetwork?.(entry.host, decision.scope ?? "global")
    }
    return true
  }

  /** Allow all pending asks for `host` (compat; no persistence). */
  allow(host: string): boolean {
    const keys = [...this.pending.keys()].filter((key) => key === host)
    if (keys.length === 0) return false
    for (const key of keys) this.settle(key, true)
    return true
  }

  /** Deny all pending asks for `host` (compat). */
  deny(host: string): boolean {
    const keys = [...this.pending.keys()].filter((key) => key === host)
    if (keys.length === 0) return false
    for (const key of keys) this.settle(key, false)
    return true
  }

  private settle(key: string, allowed: boolean): void {
    const entry = this.pending.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(key)
    this.opts.publish?.({ v: 1, cmd: "sandbox.ask.resolved", id: entry.id, allowed })
    this.opts.onAskChange?.()
    for (const resolve of entry.resolvers) resolve(allowed)
  }
}
