import { describe, expect, it } from "bun:test"
import { SandboxController } from "../src/controller"
import { SandboxRuntimeAdapter } from "../src/adapter"
import { SandboxPolicyStore } from "../src/policy-store"
import { SANDBOX_ERROR_CODES, type SandboxManagerLike, type SandboxPolicy } from "../src/types"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

function manager(overrides: Partial<SandboxManagerLike> = {}): SandboxManagerLike & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async initialize() { calls.push("initialize") },
    isSupportedPlatform() { return true },
    checkDependencies() { return { ok: true, missing: [] } },
    async wrapWithSandbox(cmd) { calls.push("wrap"); return `w(${cmd})` },
    updateConfig() { calls.push("updateConfig") },
    async reset() { calls.push("reset") },
    ...overrides,
  }
}

const policy: SandboxPolicy = {
  enabledByDefault: true,
  network: { allowedDomains: [], deniedDomains: [], strictAllowlist: false },
  filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [], allowGitConfig: false },
}

async function make(opts: { failInit?: boolean; ask?: (req: any) => Promise<boolean> } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sbx-ctl-"))
  const mgr = manager(
    opts.failInit
      ? { async initialize() { throw new Error("boom") } }
      : {},
  )
  const store = new SandboxPolicyStore({ globalPath: path.join(dir, "g.json"), projectPath: path.join(dir, "p.json") })
  const adapter = new SandboxRuntimeAdapter(mgr, { cwd: "/work" })
  const controller = new SandboxController({ adapter, policyStore: store, onAsk: opts.ask })
  return { dir, mgr, store, adapter, controller }
}

describe("SandboxController", () => {
  it("starts disabled and becomes active after enable", async () => {
    const { controller, mgr } = await make()
    expect(controller.status().state).toBe("disabled")
    await controller.enable()
    expect(controller.status().state).toBe("active")
    expect(mgr.calls).toContain("initialize")
  })

  it("is fail-closed: blocks spawn when not active", async () => {
    const { controller } = await make()
    try {
      controller.ensureExecutable()
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toBe(SANDBOX_ERROR_CODES.blocked)
    }
  })

  it("enters error state when initialize fails and never downgrades", async () => {
    const { controller, mgr } = await make({ failInit: true })
    // enable() sets state=error then re-throws; the state is observable after catch.
    await controller.enable().catch(() => {})
    expect(controller.status().state).toBe("error")
    expect(controller.status().lastError?.code).toBe(SANDBOX_ERROR_CODES.initFailed)
    try {
      controller.ensureExecutable()
      expect.unreachable()
    } catch {
      /* blocked */
    }
    expect(mgr.calls).not.toContain("wrap") // never fell back to unsandboxed
  })

  it("wraps a command and registers/unregisters a child", async () => {
    const { controller } = await make()
    await controller.enable()
    const wrapped = await controller.beforeSpawn("s1", "c1", "echo hi")
    expect(wrapped).toBe("w(echo hi)")
    expect(controller.status().activeChildren).toBe(1)
    await controller.afterSpawn("c1")
    expect(controller.status().activeChildren).toBe(0)
  })

  it("queues pending-refresh on filesystem policy change while children active", async () => {
    const { controller } = await make()
    await controller.enable()
    await controller.beforeSpawn("s1", "c1", "echo hi")
    await controller.setPolicy({ ...policy, filesystem: { ...policy.filesystem, allowWrite: ["/work/x"] } })
    expect(controller.status().state).toBe("pending-refresh")
    await controller.afterSpawn("c1")
    expect(controller.status().state).toBe("active")
  })

  it("disable resets and returns to disabled", async () => {
    const { controller, mgr } = await make()
    await controller.enable()
    await controller.disable()
    expect(controller.status().state).toBe("disabled")
    expect(mgr.calls).toContain("reset")
  })
})
