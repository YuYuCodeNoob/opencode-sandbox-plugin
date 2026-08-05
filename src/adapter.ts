import { getDefaultWritePaths } from "@anthropic-ai/sandbox-runtime"
import { SANDBOX_ERROR_CODES, type SandboxManagerLike, type SandboxPolicy } from "./types"

export class SandboxRuntimeAdapter {
  private readonly platform: NodeJS.Platform

  constructor(
    private readonly manager: SandboxManagerLike,
    private readonly opts: { cwd: string; platform?: NodeJS.Platform },
  ) {
    this.platform = opts.platform ?? process.platform
  }

  isSupported(): boolean {
    return this.manager.isSupportedPlatform()
  }

  checkDependencies(): { ok: boolean; missing: string[] } {
    const result = this.manager.checkDependencies() as { missing?: string[]; ok?: boolean } | undefined
    return { ok: result?.ok ?? true, missing: result?.missing ?? [] }
  }

  buildSrtConfig(policy: SandboxPolicy): Record<string, unknown> {
    return {
      filesystem: {
        disabled: false, // hardcoded safe default
        denyRead: policy.filesystem.denyRead,
        allowRead: policy.filesystem.allowRead,
        allowWrite: [...new Set([...policy.filesystem.allowWrite, this.opts.cwd, ...getDefaultWritePaths()])],
        denyWrite: policy.filesystem.denyWrite,
        allowGitConfig: policy.filesystem.allowGitConfig,
      },
      network: {
        allowedDomains: policy.network.allowedDomains,
        deniedDomains: policy.network.deniedDomains,
        strictAllowlist: policy.network.strictAllowlist,
        allowAllUnixSockets: false, // hardcoded safe default
        allowLocalBinding: false,
        allowMachLookup: [],
      },
    }
  }

  async wrap(command: string): Promise<string> {
    if (this.platform === "win32") {
      throw new Error(SANDBOX_ERROR_CODES.platformUnsupported)
    }
    return this.manager.wrapWithSandbox(command)
  }

  async initialize(
    config: unknown,
    ask?: (p: { host: string; port: number | undefined }) => Promise<boolean>,
  ): Promise<void> {
    return this.manager.initialize(config, ask, true)
  }

  async reset(): Promise<void> {
    return this.manager.reset()
  }

  /** Network policy is live via updateConfig; filesystem changes need reset+reinit. */
  updateConfig(policy: SandboxPolicy): void {
    this.manager.updateConfig(this.buildSrtConfig(policy))
  }

  getEffectivePolicyVersion(policy: SandboxPolicy): number {
    let hash = 0
    const json = JSON.stringify(policy)
    for (let i = 0; i < json.length; i++) {
      hash = (hash * 31 + json.charCodeAt(i)) >>> 0
    }
    return hash
  }
}
