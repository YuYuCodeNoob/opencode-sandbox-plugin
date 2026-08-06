export type SandboxState = "disabled" | "initializing" | "active" | "pending-refresh" | "error"

export interface RedactionPattern {
  name: string
  pattern: string
  replacement?: string
}

export interface SandboxPolicy {
  enabledByDefault: boolean
  network: {
    allowedDomains: string[]
    deniedDomains: string[]
    strictAllowlist: boolean
  }
  filesystem: {
    denyRead: string[]
    allowRead: string[]
    allowWrite: string[]
    denyWrite: string[]
    allowGitConfig: boolean
  }
  redaction: {
    enabled: boolean
    patterns: RedactionPattern[]
    tools: string[]
  }
}

export interface SandboxStatus {
  state: SandboxState
  enabled: boolean
  /** 有效开关来源：配置默认（enabledByDefault）或本进程 runtime override。 */
  source: "config" | "override"
  lastError: { code: string; message: string } | null
  effectivePolicyVersion: number
  activeChildren: number
  pendingRefresh: boolean
}

export interface SandboxError {
  code: string
  message: string
}

export const SANDBOX_ERROR_CODES = {
  platformUnsupported: "sandbox_platform_unsupported",
  initFailed: "sandbox_init_failed",
  dependencyMissing: "sandbox_dependency_missing",
  blocked: "sandbox_execution_blocked",
} as const

export interface AskRequest {
  host: string
  port?: number
  sessionID: string
  callID?: string
  commandSummary?: string
}

/** SRT lifecycle surface the controller depends on; injectable for tests. */
export interface SandboxManagerLike {
  initialize(
    config: unknown,
    ask?: (p: { host: string; port: number | undefined }) => Promise<boolean>,
    enableLogMonitor?: boolean,
  ): Promise<void>
  isSupportedPlatform(): boolean
  checkDependencies(cfg?: { command: string; args?: string[] }): unknown
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: unknown,
    abortSignal?: AbortSignal,
  ): Promise<string>
  updateConfig(newConfig: unknown): void
  reset(): Promise<void>
  getSandboxViolationStore?(): unknown
}
