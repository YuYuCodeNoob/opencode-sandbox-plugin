import { SandboxRuntimeAdapter } from "./adapter"
import { SandboxPolicyStore } from "./policy-store"
import {
  SANDBOX_ERROR_CODES,
  type AskRequest,
  type SandboxError,
  type SandboxPolicy,
  type SandboxState,
  type SandboxStatus,
} from "./types"

interface ChildEntry {
  sessionID: string
  startedAt: number
}

export class SandboxController {
  private state: SandboxState = "disabled"
  private lastError: SandboxError | null = null
  private effectivePolicyVersion = 0
  private children = new Map<string, ChildEntry>()
  private queue: Promise<unknown> = Promise.resolve()
  private pendingRefresh = false
  private disposed = false
  private desiredPolicy: SandboxPolicy | null = null

  constructor(
    private readonly deps: {
      adapter: SandboxRuntimeAdapter
      policyStore: SandboxPolicyStore
      onAsk?: (req: AskRequest) => Promise<boolean>
      onError?: (err: SandboxError) => void
    },
  ) {}

  status(): SandboxStatus {
    return {
      state: this.state,
      enabled: this.state !== "disabled",
      lastError: this.lastError,
      effectivePolicyVersion: this.effectivePolicyVersion,
      activeChildren: this.children.size,
      pendingRefresh: this.pendingRefresh,
    }
  }

  isActive(): boolean {
    return this.state === "active"
  }

  /** Sandbox intent is on (any state other than disabled). */
  isEnabled(): boolean {
    return this.state !== "disabled"
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  async enable(): Promise<void> {
    await this.deps.policyStore.setRuntimeOverride(true)
    await this.serialized(async () => {
      this.state = "initializing"
      this.lastError = null
      try {
        if (!this.deps.adapter.isSupported()) {
          throw new Error(SANDBOX_ERROR_CODES.platformUnsupported)
        }
        const deps = this.deps.adapter.checkDependencies()
        if (!deps.ok) {
          throw new Error(`${SANDBOX_ERROR_CODES.dependencyMissing}: ${deps.missing.join(", ")}`)
        }
        const policy = this.desiredPolicy ?? (await this.deps.policyStore.load())
        this.desiredPolicy = policy
        this.effectivePolicyVersion = this.deps.adapter.getEffectivePolicyVersion(policy)
        const config = this.deps.adapter.buildSrtConfig(policy)
        await this.deps.adapter.initialize(config, this.askCallback())
        this.state = "active"
        this.pendingRefresh = false
      } catch (e) {
        const code =
          (e as Error).message === SANDBOX_ERROR_CODES.platformUnsupported
            ? SANDBOX_ERROR_CODES.platformUnsupported
            : SANDBOX_ERROR_CODES.initFailed
        this.state = "error"
        this.lastError = { code, message: (e as Error).message }
        this.deps.onError?.(this.lastError)
        throw e
      }
    })
  }

  private askCallback() {
    return async (p: { host: string; port: number | undefined }): Promise<boolean> => {
      if (!this.deps.onAsk) return false
      const req: AskRequest = { host: p.host, port: p.port, sessionID: this.activeSession() }
      return this.deps.onAsk(req)
    }
  }

  private activeSession(): string {
    // The most recently spawned child is the current execution context.
    const entries = [...this.children.values()]
    return entries.length ? entries[entries.length - 1]!.sessionID : ""
  }

  ensureExecutable(): void {
    if (this.state !== "active") {
      throw new Error(SANDBOX_ERROR_CODES.blocked)
    }
  }

  async beforeSpawn(sessionID: string, callID: string, command: string): Promise<string> {
    this.ensureExecutable()
    const wrapped = await this.deps.adapter.wrap(command)
    this.children.set(callID, { sessionID, startedAt: Date.now() })
    return wrapped
  }

  async afterSpawn(callID: string): Promise<void> {
    this.children.delete(callID)
    await this.flushDeferredRefresh()
  }

  private async flushDeferredRefresh(): Promise<void> {
    if (!this.pendingRefresh || this.children.size > 0 || this.state !== "pending-refresh") return
    this.pendingRefresh = false
    this.state = "initializing"
    try {
      await this.reinitialize()
      this.state = "active"
    } catch (e) {
      this.state = "error"
      this.lastError = { code: SANDBOX_ERROR_CODES.initFailed, message: (e as Error).message }
    }
  }

  async setPolicy(policy: SandboxPolicy): Promise<void> {
    this.desiredPolicy = policy
    const version = this.deps.adapter.getEffectivePolicyVersion(policy)
    if (version === this.effectivePolicyVersion) return
    this.effectivePolicyVersion = version
    if (this.state !== "active") return
    if (this.children.size > 0) {
      this.pendingRefresh = true
      this.state = "pending-refresh"
      return
    }
    await this.reinitialize()
  }

  async reinitialize(): Promise<void> {
    this.state = "initializing"
    try {
      await this.deps.adapter.reset()
      const policy = this.desiredPolicy ?? (await this.deps.policyStore.load())
      const config = this.deps.adapter.buildSrtConfig(policy)
      await this.deps.adapter.initialize(config, this.askCallback())
      this.state = "active"
    } catch (e) {
      this.state = "error"
      this.lastError = { code: SANDBOX_ERROR_CODES.initFailed, message: (e as Error).message }
      throw e
    }
  }

  /**
   * Allow a network domain: persist to config, update in-memory desired policy,
   * and apply live via updateConfig (network changes take effect immediately).
   */
  async allowNetwork(host: string, scope: "project" | "global" = "global"): Promise<void> {
    await this.mutateNetwork("allowedDomains", host, scope)
  }

  /** Deny a network domain (takes precedence over allow). */
  async denyNetwork(host: string, scope: "project" | "global" = "global"): Promise<void> {
    await this.mutateNetwork("deniedDomains", host, scope)
  }

  private async mutateNetwork(
    field: "allowedDomains" | "deniedDomains",
    host: string,
    scope: "project" | "global",
  ): Promise<void> {
    const policy = this.desiredPolicy ?? (await this.deps.policyStore.load())
    const list = new Set(policy.network[field])
    list.add(host)
    const next: SandboxPolicy = {
      ...policy,
      network: { ...policy.network, [field]: [...list] },
    }
    this.desiredPolicy = next
    if (field === "allowedDomains") await this.deps.policyStore.addAllowedDomain(host, scope)
    else await this.deps.policyStore.addDeniedDomain(host, scope)
    this.effectivePolicyVersion = this.deps.adapter.getEffectivePolicyVersion(next)
    if (this.state === "active" || this.state === "pending-refresh") {
      await this.serialized(async () => {
        this.deps.adapter.updateConfig(next)
      })
    }
  }

  async disable(): Promise<void> {
    await this.deps.policyStore.setRuntimeOverride(false)
    await this.serialized(async () => {
      this.children.clear()
      await this.deps.adapter.reset()
      this.state = "disabled"
      this.pendingRefresh = false
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.serialized(async () => {
      await this.deps.adapter.reset()
    })
  }
}
