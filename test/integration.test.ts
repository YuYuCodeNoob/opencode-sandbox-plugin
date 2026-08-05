/**
 * Real-SRT integration tests (run with `RUN_SRT=1 bun test test/integration.test.ts`).
 *
 * These exercise the actual bwrap sandbox boundary, not mocks. Skipped by
 * default. Requires Linux + bwrap/socat/ripgrep.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { SandboxManager, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime"
import { SandboxRuntimeAdapter } from "../src/adapter"
import { SANDBOX_ERROR_CODES, type SandboxPolicy } from "../src/types"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const run = !!process.env.RUN_SRT
const describeIntegration = run ? describe : describe.skip

const policy: SandboxPolicy = {
  enabledByDefault: true,
  network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
  filesystem: { denyRead: ["~/.ssh"], allowRead: [], allowWrite: [], denyWrite: [], allowGitConfig: false },
}

async function runWrapped(wrapped: string, timeoutMs = 20_000) {
  const p = Bun.spawn(["/bin/bash", "-c", wrapped], { stdout: "pipe", stderr: "pipe" })
  const killer = setTimeout(() => p.kill(), timeoutMs)
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  clearTimeout(killer)
  await p.exited // wait for the real exit code
  return { exit: p.exitCode, stdout, stderr }
}

describeIntegration("SRT integration (RUN_SRT=1)", () => {
  let cwd: string
  let adapter: SandboxRuntimeAdapter

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "sbx-int-"))
    adapter = new SandboxRuntimeAdapter(SandboxManager, { cwd })
    await SandboxManager.initialize(
      adapter.buildSrtConfig({ ...policy, filesystem: { ...policy.filesystem, allowWrite: [cwd] } }) as any,
      undefined,
      true,
    )
  })

  afterAll(async () => {
    await SandboxManager.reset().catch(() => {})
    await rm(cwd, { recursive: true, force: true })
  })

  it("reports platform support and no missing dependencies", () => {
    expect(adapter.isSupported()).toBe(true)
    expect(adapter.checkDependencies().missing).toEqual([])
  })

  it("wraps a command with a real bwrap prefix", async () => {
    const wrapped = await adapter.wrap("echo hello")
    expect(wrapped).toContain("bwrap")
  })

  it("translates product policy to a schema-valid SRT config", () => {
    const config = adapter.buildSrtConfig(policy)
    expect(SandboxRuntimeConfigSchema.safeParse(config).success).toBe(true)
    // fixed safe defaults
    const cfg = config as Record<string, any>
    expect(cfg.filesystem.disabled).toBe(false)
    expect(cfg.network.allowAllUnixSockets).toBe(false)
    expect(cfg.filesystem.allowWrite).toContain(cwd)
  })

  it("runs a wrapped command successfully in the sandbox", async () => {
    const wrapped = await adapter.wrap("echo sandboxed")
    const r = await runWrapped(wrapped)
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain("sandboxed")
  })

  it("allows writing inside the allowlisted cwd", async () => {
    const target = path.join(cwd, "ok.txt")
    const wrapped = await adapter.wrap(`printf hi > ${JSON.stringify(target)}`)
    const r = await runWrapped(wrapped)
    expect(r.exit).toBe(0)
    expect(await readFile(target, "utf-8")).toBe("hi")
  })

  it("blocks writes outside the allowlist and records a violation", async () => {
    const before = SandboxManager.getSandboxViolationStore().getViolations().length
    const target = path.join(tmpdir(), `sbx-denied-${Date.now()}.txt`)
    const wrapped = await adapter.wrap(`touch ${JSON.stringify(target)}`)
    const r = await runWrapped(wrapped)
    expect(r.exit).not.toBe(0)
    expect(r.stderr.toLowerCase()).toContain("read-only") // sandbox boundary actually enforced
    expect(SandboxManager.getSandboxViolationStore().getViolations().length).toBeGreaterThan(before)
    await rm(target, { force: true })
  })

  it("throws platformUnsupported on win32 without touching the manager", async () => {
    const winAdapter = new SandboxRuntimeAdapter(SandboxManager, { cwd, platform: "win32" })
    try {
      await winAdapter.wrap("echo hi")
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toBe(SANDBOX_ERROR_CODES.platformUnsupported)
    }
  })
})
