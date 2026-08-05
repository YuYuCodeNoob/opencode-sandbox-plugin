import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createSandboxPlugin } from "../src/plugin"
import { encodeTuiCommand, type SandboxTuiCommand } from "../src/tui-protocol"
import { readRuntime, type SandboxRuntime } from "../src/runtime-store"
import type { SandboxManagerLike } from "../src/types"
import type { V2ClientLike } from "../src/transparency"

function fakeManager(): SandboxManagerLike {
  return {
    async initialize() {},
    isSupportedPlatform() { return true },
    checkDependencies() { return { ok: true, missing: [] } },
    async wrapWithSandbox(cmd) { return `w(${cmd})` },
    updateConfig() {},
    async reset() {},
  }
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function make(opts: { globalPath?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sbx-pl-"))
  dirs.push(dir)
  const globalPath = opts.globalPath ?? path.join(dir, "g.json")
  const runtimeFile = path.join(path.dirname(globalPath), "runtime.json")
  const client: V2ClientLike = {
    session: { messages: async () => [] },
    part: { update: async () => ({}) },
    permission: { reply: async () => ({}) },
    tui: {
      showToast: async () => ({}),
      publish: async () => ({}),
    },
  }
  const hooks = createSandboxPlugin(
    { directory: "/work", serverUrl: new URL("http://localhost:4096"), client } as any,
    {
      manager: fakeManager(),
      globalConfigPath: globalPath,
      projectConfigPath: path.join(dir, "p.json"),
      client,
    },
  )
  return { hooks, runtimeFile, dir }
}

function sendEvent(hooks: { event?: (i: any) => Promise<void> }, cmd: SandboxTuiCommand) {
  return hooks.event?.({ event: { id: "e1", type: "tui.command.execute", properties: { command: encodeTuiCommand(cmd) } } } as any)
}

async function waitForState(runtimeFile: string, state: string, timeout = 3000): Promise<SandboxRuntime | null> {
  const deadline = Date.now() + timeout
  let r: SandboxRuntime | null = null
  while (Date.now() < deadline) {
    r = await readRuntime(runtimeFile)
    if (r?.state === state) return r
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return r
}

describe("server plugin tui.command.execute channel", () => {
  it("sandbox.get writes the shared runtime file", async () => {
    const { hooks, runtimeFile } = await make()
    await sendEvent(hooks, { v: 1, cmd: "sandbox.get" })
    const r = await waitForState(runtimeFile, "disabled")
    expect(r?.enabled).toBe(false)
    expect(r?.source).toBe("config")
  })

  it("sandbox.toggle enables then disables (runtime file reflects it)", async () => {
    const { hooks, runtimeFile } = await make()
    await sendEvent(hooks, { v: 1, cmd: "sandbox.toggle" })
    const active = await waitForState(runtimeFile, "active")
    expect(active?.enabled).toBe(true)
    expect(active?.source).toBe("override") // enable() sets runtimeOverride
    await sendEvent(hooks, { v: 1, cmd: "sandbox.toggle" })
    const disabled = await waitForState(runtimeFile, "disabled")
    expect(disabled?.enabled).toBe(false)
  })

  it("ignores foreign commands and leaves state unchanged", async () => {
    const { hooks, runtimeFile } = await make()
    // initial refresh (auto-enable settle) writes the runtime file once with disabled.
    await waitForState(runtimeFile, "disabled")
    await hooks.event?.({
      event: { id: "e2", type: "tui.command.execute", properties: { command: JSON.stringify({ v: 1, cmd: "other.plugin.cmd" }) } },
    } as any)
    await hooks.event?.({ event: { id: "e3", type: "some.other.event", properties: {} } } as any)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const r = await readRuntime(runtimeFile)
    expect(r?.state).toBe("disabled") // unchanged by foreign commands
    expect(r?.asks).toEqual([])
  })

  it("auto-enables when enabledByDefault is true (runtime file active)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbx-pl-"))
    dirs.push(dir)
    const globalPath = path.join(dir, "g.json")
    await writeFile(globalPath, JSON.stringify({ enabledByDefault: true }))
    const { runtimeFile } = await make({ globalPath })
    const active = await waitForState(runtimeFile, "active")
    expect(active?.enabled).toBe(true)
  })
})
