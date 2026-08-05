import { describe, expect, it } from "bun:test"
import { SandboxController } from "../src/controller"
import { SandboxRuntimeAdapter } from "../src/adapter"
import { SandboxPolicyStore } from "../src/policy-store"
import { SANDBOX_ERROR_CODES, type SandboxManagerLike, type SandboxPolicy } from "../src/types"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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

  it("status().source reflects config default vs runtime override", async () => {
    const { controller } = await make()
    expect(controller.status().source).toBe("config") // no override set
    await controller.enable() // enable() sets runtimeOverride=true
    expect(controller.status().source).toBe("override")
    await controller.disable()
    expect(controller.status().source).toBe("override") // override=false still an override
  })

  it("fires onStateChange at terminal transitions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbx-ctl-"))
    const mgr = manager()
    const store = new SandboxPolicyStore({ globalPath: path.join(dir, "g.json"), projectPath: path.join(dir, "p.json") })
    const adapter = new SandboxRuntimeAdapter(mgr, { cwd: "/work" })
    const states: string[] = []
    const controller = new SandboxController({
      adapter,
      policyStore: store,
      onStateChange: (s) => states.push(s.state),
    })
    await controller.enable()
    await controller.disable()
    expect(states).toContain("active")
    expect(states).toContain("disabled")
  })

  it("allowNetwork updates config live and persists the domain", async () => {
    const { dir, controller, mgr } = await make()
    await controller.enable()
    await controller.allowNetwork("api.example.com", "project")
    expect(mgr.calls).toContain("updateConfig")
    const onDisk = JSON.parse(await readFile(path.join(dir, "p.json"), "utf-8"))
    expect(onDisk.network.allowedDomains).toContain("api.example.com")
  })

  it("allowNetwork persists even while disabled (applies on next enable)", async () => {
    const { dir, controller, mgr } = await make()
    await controller.allowNetwork("api.example.com", "global")
    expect(mgr.calls).not.toContain("updateConfig") // not active → no live update
    const onDisk = JSON.parse(await readFile(path.join(dir, "g.json"), "utf-8"))
    expect(onDisk.network.allowedDomains).toContain("api.example.com")
  })
})
