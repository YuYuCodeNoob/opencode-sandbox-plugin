/**
 * TransparencyRepair — 透明抽象（CLAUDE.md §6.1）
 *
 * bash tool 的 `tool.execute.before` 会把 `args.command` 改写为 SRT 的 bwrap
 * 包装命令，真实流入 spawn。包装前缀绝不能落入 DB / 展示 / LLM 上下文。
 * 本模块在 `tool.execute.after` 时定位该调用的 tool part，并把
 * `state.input.command` 恢复为原始命令，同时把完整 part 写回（HTTP handler
 * 要求 payload 的 id/messageID/sessionID 与路径参数一致）。
 */

type PartLike = {
  id: string
  sessionID: string
  messageID: string
  type: string
  callID?: string
  tool?: string
  state?: { input?: { command?: string }; [key: string]: unknown }
}

/** v2 client 中用到的面（插桩最小集合，便于测试）。 */
export interface V2ClientLike {
  session: {
    messages(params: { sessionID: string }): Promise<Array<{ info: { id: string }; parts: PartLike[] }>>
  }
  part: {
    update(params: { sessionID: string; messageID: string; partID: string; part: PartLike }): Promise<unknown>
  }
  permission: {
    /** v1 权限回复端点 `/permission/{requestID}/reply`（解析 bash 工具进程内创建的请求）。 */
    reply(params: { requestID: string; reply: "once" | "always" | "reject" }): Promise<unknown>
  }
  tui: {
    showToast(params: { title: string; message: string; variant: string; duration?: number }): Promise<unknown>
    /** 向 TUI 广播 `tui.command.execute` 事件（TUI 插件 api.event.on 可收到）。 */
    publish(params: { body: { type: string; properties: Record<string, unknown> } }): Promise<unknown>
  }
}

export class TransparencyRepair {
  private originals = new Map<string, string>()

  /** Record the original command before the wrapped command replaces it. */
  register(callID: string, original: string): void {
    this.originals.set(callID, original)
  }

  /** Whether this callID was wrapped by the plugin (used for permission takeover). */
  hasWrapped(callID: string): boolean {
    return this.originals.has(callID)
  }

  /** Non-consuming read of the original command (used to fix the tool title). */
  peekOriginal(callID: string): string | undefined {
    return this.originals.get(callID)
  }

  /** Consume the original command for a callID (idempotent per call). */
  takeOriginal(callID: string): string | undefined {
    const value = this.originals.get(callID)
    this.originals.delete(callID)
    return value
  }

  /**
   * Restore the original command for `callID` in the stored tool part.
   * Best-effort: missing original / part / messages endpoint are all no-ops.
   */
  async repair(client: V2ClientLike, sessionID: string, callID: string): Promise<void> {
    const original = this.takeOriginal(callID)
    if (original === undefined) return
    const part = await this.findPart(client, sessionID, callID)
    if (!part) return
    const input = part.state?.input
    if (input === undefined) return
    await client.part.update({
      sessionID,
      messageID: part.messageID,
      partID: part.id,
      part: {
        ...part,
        state: { ...part.state, input: { ...input, command: original } },
      },
    })
  }

  private async findPart(
    client: V2ClientLike,
    sessionID: string,
    callID: string,
  ): Promise<(PartLike & { messageID: string }) | undefined> {
    try {
      const messages = await client.session.messages({ sessionID })
      for (const msg of messages) {
        for (const part of msg.parts) {
          if (part.type === "tool" && part.callID === callID) {
            return { ...part, messageID: msg.info.id }
          }
        }
      }
    } catch {
      /* best-effort */
    }
    return undefined
  }
}
