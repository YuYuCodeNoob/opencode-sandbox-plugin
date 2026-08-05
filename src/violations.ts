/**
 * ViolationReporter — 文件/网络违规 → toast（CLAUDE.md §8）。
 *
 * 订阅 SRT `SandboxViolationStore`，对新增违规展示 warning toast；同时保留
 * 最近违规供 `sandbox_status` 自定义工具查询。违规内容只含去敏摘要（line），
 * 不记录命令中的 token / 凭据。
 */

import type { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime"
import type { V2ClientLike } from "./transparency"

type ViolationLike = { line: string; timestamp: Date }

export interface ViolationInfo {
  line: string
  at: string
}

export class ViolationReporter {
  private seen = new Set<string>()
  private started = false

  constructor(
    private readonly client: V2ClientLike,
    private readonly store: SandboxViolationStore,
  ) {}

  /** Begin observing the violation store. Safe to call repeatedly. */
  start(): void {
    if (this.started) return
    this.started = true
    this.store.subscribe((violations) => {
      for (const violation of violations) this.consider(violation)
    })
  }

  /** Recent violations for the status tool (oldest-first, bounded). */
  recent(limit = 10): ViolationInfo[] {
    return this.store.getViolations(limit).map((v) => ({ line: v.line, at: v.timestamp.toISOString() }))
  }

  private consider(violation: ViolationLike): void {
    const key = `${violation.timestamp.toISOString()}:${violation.line}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    void this.client.tui.showToast({
      title: "Sandbox violation",
      message: violation.line,
      variant: "warning",
      duration: 6000,
    })
  }
}
