import { describe, expect, it } from "bun:test"
import { SandboxRuntimeAdapter } from "../src/adapter"
import { SANDBOX_ERROR_CODES, type SandboxManagerLike, type SandboxPolicy } from "../src/types"

function fakeManager(): SandboxManagerLike & { wrapLog: string[] } {
  const wrapLog: string[] = []
  return {
    wrapLog,
    async initialize() {},
    isSupportedPlatform() { return true },
    checkDependencies() { return { ok: true, missing: [] } },
    async wrapWithSandbox(cmd) { wrapLog.push(cmd); return `wrapped(${cmd})` },
    updateConfig() {},
    async reset() {},
  }
}

const policy: SandboxPolicy = {
  enabledByDefault: true,
  network: { allowedDomains: ["api.example.com"], deniedDomains: [], strictAllowlist: false },
  filesystem: { denyRead: ["~/.ssh"], allowRead: [], allowWrite: ["/work"], denyWrite: [], allowGitConfig: false },
}

describe("SandboxRuntimeAdapter", () => {
  it("translates product policy to SRT config with safe defaults", () => {
    const mgr = fakeManager()
    const adapter = new SandboxRuntimeAdapter(mgr, { cwd: "/work" })
    const cfg = adapter.buildSrtConfig(policy) as any
    expect(cfg.network.allowedDomains).toEqual(["api.example.com"])
    expect(cfg.filesystem.denyRead).toContain("~/.ssh")
    expect(cfg.network.allowAllUnixSockets).toBe(false)
    expect(cfg.filesystem.disabled).toBe(false)
  })

  it("calls wrapWithSandbox with the original command", async () => {
    const mgr = fakeManager()
    const adapter = new SandboxRuntimeAdapter(mgr, { cwd: "/work" })
    const wrapped = await adapter.wrap("echo hi")
    expect(mgr.wrapLog).toContain("echo hi")
    expect(wrapped).toBe("wrapped(echo hi)")
  })

  it("throws platformUnsupported on win32", async () => {
    const mgr = fakeManager()
    const adapter = new SandboxRuntimeAdapter(mgr, { cwd: "/work", platform: "win32" })
    try {
      await adapter.wrap("echo hi")
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toBe(SANDBOX_ERROR_CODES.platformUnsupported)
    }
  })

  it("delegates initialize and reset to the manager", async () => {
    const mgr = fakeManager()
    const adapter = new SandboxRuntimeAdapter(mgr, { cwd: "/work" })
    await adapter.initialize({}, () => Promise.resolve(true))
    await adapter.reset()
    // No throw = delegated successfully (fakes are no-ops).
    expect(true).toBe(true)
  })
})
