/**
 * PermissionBridge — 等待式半交互网络授权（CLAUDE.md §7，用户确认变体）
 *
 * SRT `sandboxAskCallback` 会在沙箱命令访问未配置 host 时阻塞连接并等待
 * `Promise<boolean>`。本桥把一次阻塞等待表面化成一个 TUI toast + 待决请求：
 * 用户通过 `sandbox_allow {host}` / `sandbox_deny {host}` 工具作出决定，
 * 桥随即 resolve 等待中的回调（true → 当前连接立即放行），否则超时后
 * 默认拒绝。
 *
 * 说明：当前 OpenCode 的 TUI 只渲染 v1 `permission.asked` 事件、且 v1 权限
 * 系统没有 HTTP create 端点，因此这里不创建服务端 permission 请求，而是
 * 走 toast + 工具的直接交互路径。
 */

import type { AskRequest } from "./types"
import type { V2ClientLike } from "./transparency"

interface Pending {
  host: string
  port: number | undefined
  resolvers: Array<(allowed: boolean) => void>
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 15_000

export class PermissionBridge {
  private pending = new Map<string, Pending>()

  constructor(
    private readonly client: V2ClientLike,
    private readonly opts: { timeoutMs?: number; toast?: boolean } = {},
  ) {}

  getPendingCount(): number {
    return this.pending.size
  }

  /** Hosts currently awaiting a decision (for sandbox_status). */
  pendingHosts(): Array<{ host: string; port: number | undefined }> {
    return [...this.pending.values()].map((p) => ({ host: p.host, port: p.port }))
  }

  /**
   * Called by the controller's askCallback. Returns a promise that stays
   * pending until `allow`/`deny` resolves it (→ current connection proceeds)
   * or the timeout elapses (→ denied).
   */
  handleAsk(req: AskRequest): Promise<boolean> {
    const key = req.host
    const existing = this.pending.get(key)
    if (existing) {
      // Same-host concurrency: share one prompt, add a waiter.
      return new Promise<boolean>((resolve) => existing.resolvers.push(resolve))
    }
    const entry: Pending = {
      host: req.host,
      port: req.port,
      resolvers: [],
      timer: setTimeout(() => this.settle(key, false), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    }
    this.pending.set(key, entry)
    if (this.opts.toast ?? true) {
      const label = req.port !== undefined ? `${req.host}:${req.port}` : req.host
      const seconds = Math.round((this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)
      void this.client.tui.showToast({
        title: "Sandbox network access",
        message: `"${label}" is not in the network allowlist. Allow it (e.g. reply "allow ${req.host}") or it will be denied after ${seconds}s.`,
        variant: "warning",
        duration: (this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 5_000,
      })
    }
    return new Promise<boolean>((resolve) => entry.resolvers.push(resolve))
  }

  /** Allow all pending asks for `host` (returns false if none were pending). */
  allow(host: string): boolean {
    return this.resolve(host, true)
  }

  /** Deny all pending asks for `host` (returns false if none were pending). */
  deny(host: string): boolean {
    return this.resolve(host, false)
  }

  private resolve(host: string, allowed: boolean): boolean {
    const keys = [...this.pending.keys()].filter((key) => key === host)
    if (keys.length === 0) return false
    for (const key of keys) this.settle(key, allowed)
    return true
  }

  private settle(key: string, allowed: boolean): void {
    const entry = this.pending.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(key)
    for (const resolve of entry.resolvers) resolve(allowed)
  }
}
