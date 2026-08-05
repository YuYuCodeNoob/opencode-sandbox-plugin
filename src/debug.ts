/**
 * 轻量调试日志（`~/.config/opencode-sandbox/debug.log`）。
 *
 * 只记录与透明修复/HTTP 通道相关的低量事件，便于在编译版 opencode 中确认
 * v2 client 是否真正到达 server（连接/鉴权/响应形状问题）。不会记录命令内容、
 * token 或凭据 —— 只记动作 + 结果 + 去敏错误。
 */

import os from "node:os"
import path from "node:path"
import { appendFileSync, mkdirSync } from "node:fs"

export function debugLog(...parts: unknown[]): void {
  try {
    const dir = path.join(os.homedir(), ".config", "opencode-sandbox")
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      path.join(dir, "debug.log"),
      `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : safeStringify(p))).join(" ")}\n`,
    )
  } catch {
    /* logging is best-effort */
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
