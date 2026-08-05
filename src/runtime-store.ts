/**
 * SandboxRuntimeStore — server ↔ TUI 的共享状态文件。
 *
 * opencode 的 SSE 事件路由在部分部署（如编译版 opencode）里不会把服务端
 * 发布的事件送达 TUI 插件（`event.location.directory` 与 TUI instance 不匹配，
 * 见 debugging 记录）。因此 server→TUI 的方向改用共享文件：
 *
 *   server 进程：每次状态 / 待决 ask 变化时写 `~/.config/opencode-sandbox/runtime.json`
 *   TUI 进程：  轮询读该文件渲染开关 + 授权弹窗
 *
 * TUI→server 方向仍走 `tui.command.execute` 事件（已验证可达）。
 * 本地部署（server 与 TUI 同机）下可靠；远程 server 不在 v1 范围。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SandboxError, SandboxState } from "./types"

export interface RuntimeAsk {
  id: string
  host: string
  port?: number
  /** epoch ms；到点仍未决策 → server 自动拒绝并移除。 */
  expiresAt: number
}

export interface SandboxRuntime {
  state: SandboxState
  enabled: boolean
  /** 有效开关来源：配置默认 or 本进程 override。 */
  source: "config" | "override"
  override: boolean
  activeChildren: number
  pendingRefresh: boolean
  lastError: SandboxError | null
  asks: RuntimeAsk[]
}

/** runtime.json 与全局 config.json 同目录（~/.config/opencode-sandbox/）。 */
export function runtimePathFor(globalConfigPath: string): string {
  return path.join(path.dirname(globalConfigPath), "runtime.json")
}

export async function writeRuntime(file: string, data: SandboxRuntime): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(data, null, 2), "utf-8")
}

export async function readRuntime(file: string): Promise<SandboxRuntime | null> {
  try {
    const raw = await readFile(file, "utf-8")
    const parsed = JSON.parse(raw) as Partial<SandboxRuntime>
    if (parsed && typeof parsed === "object" && typeof parsed.state === "string") {
      return {
        state: parsed.state as SandboxState,
        enabled: parsed.enabled ?? false,
        source: parsed.source === "override" ? "override" : "config",
        override: parsed.override ?? false,
        activeChildren: parsed.activeChildren ?? 0,
        pendingRefresh: parsed.pendingRefresh ?? false,
        lastError: parsed.lastError ?? null,
        asks: Array.isArray(parsed.asks) ? parsed.asks : [],
      }
    }
    return null
  } catch {
    return null
  }
}
