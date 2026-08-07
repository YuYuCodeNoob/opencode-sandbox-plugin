/**
 * TransparencyRepair — 透明抽象（CLAUDE.md §6.1）
 *
 * bash tool 的 `tool.execute.before` 会把 `args.command` 改写为 SRT 的 bwrap
 * 包装命令，真实流入 spawn。包装前缀绝不能落入 DB / 展示 / LLM 上下文。
 *
 * 本模块在 `tool.execute.after` 时定位该调用的 tool part，并把
 * `state.input.command` 恢复为原始命令，同时把完整 part 写回（HTTP handler
 * 要求 payload 的 id/messageID/sessionID 与路径参数一致）。
 *
 * 注意：v2 SDK 的 client 方法返回 `{ data, request, response }` 包装（不是裸
 * 数组/对象）。`findPart` 必须解包 `data`，否则永远找不到 part，修复静默失败
 * —— 这是 bwrap 命令泄漏进展示的根因（已实测验证）。
 */

import { debugLog } from "./debug"

type PartLike = {
  id: string
  sessionID: string
  messageID: string
  type: string
  callID?: string
  tool?: string
  state?: { input?: { command?: string }; [key: string]: unknown }
}

type MessageLike = {
  info: { id: string; sessionID?: string }
  parts: PartLike[]
}

/** v2 client 中用到的面（插桩最小集合，便于测试）。 */
export interface V2ClientLike {
  session: {
    messages(params: { sessionID: string }): Promise<unknown>
    message(params: { sessionID: string; messageID: string }): Promise<unknown>
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

/** 解包 v2 client 的 `{ data, ... }` 响应为数组（容忍裸数组，用于测试 mock）。 */
function unwrapArray(res: unknown): MessageLike[] {
  if (Array.isArray(res)) return res as MessageLike[]
  if (res && typeof res === "object" && Array.isArray((res as { data?: unknown }).data)) {
    return (res as { data: MessageLike[] }).data
  }
  return []
}

/** 解包 v2 client 的单条消息响应（容忍裸对象，用于测试 mock）。 */
function unwrapMessage(res: unknown): MessageLike | undefined {
  if (!res || typeof res !== "object") return undefined
  const candidate = "data" in (res as object) ? (res as { data: unknown }).data : res
  if (candidate && typeof candidate === "object" && "parts" in (candidate as object)) {
    return candidate as MessageLike
  }
  return undefined
}

export class TransparencyRepair {
  private originals = new Map<string, string>()
  /** callID -> sessionID, retained for transform-time part updates. */
  private sessionIDs = new Map<string, string>()
  /** callID → 所在 messageID（来自 permission.asked 事件的 tool.messageID，加速定位）。 */
  private messageIDs = new Map<string, string>()

  /** Record the original command before the wrapped command replaces it. */
  register(callID: string, original: string): void {
    this.originals.set(callID, original)
  }

  registerSessionID(callID: string, sessionID: string): void {
    this.sessionIDs.set(callID, sessionID)
  }

  /** Record the message that holds this call's tool part (learned from permission.asked). */
  registerMessageID(callID: string, messageID: string): void {
    this.messageIDs.set(callID, messageID)
  }

  /** Non-consuming read of the messageID hint. */
  peekMessageID(callID: string): string | undefined {
    return this.messageIDs.get(callID)
  }

  /** Whether this callID was wrapped by the plugin (used for permission takeover). */
  hasWrapped(callID: string): boolean {
    return this.originals.has(callID)
  }

  /** Non-consuming read of the original command (used to fix the tool title). */
  peekOriginal(callID: string): string | undefined {
    return this.originals.get(callID)
  }

  /** Recover the original command from memory or the SRT wrapper metadata. */
  restoreCommand(callID: string | undefined, command: string): string | undefined {
    if (callID) {
      const original = this.peekOriginal(callID)
      if (original !== undefined) return original
    }

    const encoded = command.match(/--setenv\s+SRT_ENCODED_CMD\s+([^\s]+)/)?.[1]
    if (!encoded) return undefined
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8")
      return decoded || undefined
    } catch {
      return undefined
    }
  }

  /**
   * Remove sandbox wrapper commands from the messages sent to the LLM and
   * persist the cleaned tool parts. The returned messages are always safe even
   * when a part update fails.
   */
  async sanitizeMessages(client: V2ClientLike, messages: MessageLike[]): Promise<MessageLike[]> {
    const repairs: Promise<unknown>[] = []
    let toolParts = 0
    let wrappedParts = 0
    let restoredParts = 0
    const sanitized = messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) => {
        if (part.type === "tool") toolParts++
        const command = part.state?.input?.command
        const wrapped = typeof command === "string" && command.includes("bwrap")
        if (!wrapped) return part
        wrappedParts++

        const original = this.restoreCommand(part.callID, command)
        const safeCommand = original ?? "[sandboxed command]"
        if (original !== undefined) restoredParts++
        const repaired = {
          ...part,
          state: { ...part.state, input: { ...part.state?.input, command: safeCommand } },
        }
        const sessionID =
          part.sessionID ?? message.info.sessionID ?? (part.callID ? this.sessionIDs.get(part.callID) : undefined)
        if (sessionID && message.info.id && part.id) {
          debugLog("transparency:transform:part-update", {
            callID: part.callID,
            hasSessionID: true,
            restored: original !== undefined,
          })
          repairs.push(
            client.part
              .update({
                sessionID,
                messageID: message.info.id,
                partID: part.id,
                part: repaired,
              })
              .catch(() => undefined),
          )
        } else {
          debugLog("transparency:transform:part-update-skipped", {
            callID: part.callID,
            hasSessionID: Boolean(sessionID),
            hasMessageID: Boolean(message.info.id),
            hasPartID: Boolean(part.id),
          })
        }
        return repaired
      }),
    }))

    await Promise.all(repairs)
    debugLog("transparency:transform:summary", {
      messages: messages.length,
      toolParts,
      wrappedParts,
      restoredParts,
      updates: repairs.length,
    })
    return sanitized
  }

  /** Consume the original command for a callID (idempotent per call). */
  takeOriginal(callID: string): string | undefined {
    const value = this.originals.get(callID)
    if (value !== undefined) this.originals.delete(callID)
    this.messageIDs.delete(callID)
    return value
  }

  /**
   * Restore the original command for `callID` in the stored tool part.
   * Best-effort: missing original / part / messages endpoint are all no-ops.
   *
   * `messageIDHint`（permission.asked 提供）命中时只拉取单条消息，避免全量
   * session 扫描（慢、易超时）；未命中回退全量扫描。两者都先解包 v2 的
   * `{ data }` 响应。
   */
  async repair(client: V2ClientLike, sessionID: string, callID: string, messageIDHint?: string): Promise<void> {
    const original = this.peekOriginal(callID)
    if (original === undefined) return
    const part = await this.findPart(client, sessionID, callID, messageIDHint)
    if (!part) {
      debugLog("transparency:part-not-found", { callID, hint: messageIDHint ? "yes" : "no" })
      return
    }
    const input = part.state?.input
    if (input === undefined) return
    try {
      await client.part.update({
        sessionID,
        messageID: part.messageID,
        partID: part.id,
        part: {
          ...part,
          state: { ...part.state, input: { ...input, command: original } },
        },
      })
      debugLog("transparency:repaired", { callID, messageID: part.messageID, partID: part.id })
      this.takeOriginal(callID)
    } catch (error) {
      debugLog("transparency:update-failed", { callID, error: String(error).slice(0, 200) })
    }
  }

  private async findPart(
    client: V2ClientLike,
    sessionID: string,
    callID: string,
    messageIDHint?: string,
  ): Promise<(PartLike & { messageID: string }) | undefined> {
    try {
      if (messageIDHint) {
        const msg = unwrapMessage(await client.session.message({ sessionID, messageID: messageIDHint }))
        const part = msg?.parts?.find((p) => p.type === "tool" && p.callID === callID)
        if (part && msg) return { ...part, messageID: msg.info.id }
        // 提示路径未命中（提示过期/错误）→ 回退全量扫描
      }
      const messages = unwrapArray(await client.session.messages({ sessionID }))
      for (const msg of messages) {
        const part = msg.parts?.find((p) => p.type === "tool" && p.callID === callID)
        if (part) return { ...part, messageID: msg.info.id }
      }
    } catch {
      /* best-effort */
    }
    return undefined
  }
}
