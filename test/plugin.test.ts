import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createSandboxPlugin } from "../src/plugin"
import { decodeTuiCommand, encodeTuiCommand, type SandboxTuiCommand } from "../src/tui-protocol"
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

function make(opts: { globalPath?: string } = {}) {
  const published: string[] = []
  const client: V2ClientLike = {
    session: { messages: async () => [] },
    part: { update: async () => ({}) },
    permission: { reply: async () => ({}) },
    tui: {
      showToast: async () => ({}),
      publish: async (p: { body: { properties: Record<string, unknown> } }) => {
        published.push(String(p.body.properties.command))
      },
    },
  }
  const hooks = createSandboxPlugin(
    { directory: "/work", serverUrl: new URL("http://localhost:4096"), client } as any,
    {
      manager: fakeManager(),
      globalConfigPath: opts.globalPath ?? "/tmp/sbx-g.json",
      projectConfigPath: "/tmp/sbx-p.json",
      client,
    },
  )
  return { hooks, published }
}

function sendEvent(hooks: { event?: (i: any) => Promise<void> }, cmd: SandboxTuiCommand) {
  return hooks.event?.({ event: { id: "e1", type: "tui.command.execute", properties: { command: encodeTuiCommand(cmd) } } } as any)
}

describe("server plugin tui.command.execute channel", () => {
  it("sandbox.get pushes a sandbox.state message", async () => {
    const { hooks, published } = make()
    await sendEvent(hooks, { v: 1, cmd: "sandbox.get" })
    const msg = decodeTuiCommand(published[0]!)
    expect(msg?.cmd).toBe("sandbox.state")
  })

  it("sandbox.toggle enables when disabled and pushes state", async () => {
    const { hooks, published } = make()
    await sendEvent(hooks, { v: 1, cmd: "sandbox.toggle" })
    const states = published.map((c) => decodeTuiCommand(c)).filter((m): m is Extract<SandboxTuiCommand, { cmd: "sandbox.state" }> => m?.cmd === "sandbox.state")
    const last = states.at(-1)!
    expect(last.state).toBe("active")
    expect(last.enabled).toBe(true)
    // toggle again → disabled
    await sendEvent(hooks, { v: 1, cmd: "sandbox.toggle" })
    const last2 = published.map((c) => decodeTuiCommand(c)).filter((m): m is Extract<SandboxTuiCommand, { cmd: "sandbox.state" }> => m?.cmd === "sandbox.state").at(-1)!
    expect(last2.state).toBe("disabled")
  })

  it("ignores foreign commands", async () => {
    const { hooks, published } = make()
    await hooks.event?.({
      event: { id: "e2", type: "tui.command.execute", properties: { command: JSON.stringify({ v: 1, cmd: "other.plugin.cmd" }) } },
    } as any)
    await hooks.event?.({ event: { id: "e3", type: "some.other.event", properties: {} } } as any)
    expect(published).toEqual([])
  })

  it("auto-enables when enabledByDefault is true", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbx-pl-"))
    const globalPath = path.join(dir, "g.json")
    await writeFile(globalPath, JSON.stringify({ enabledByDefault: true }))
    const { published } = make({ globalPath })
    const hasActive = () =>
      published.some((c) => {
        const m = decodeTuiCommand(c)
        return m?.cmd === "sandbox.state" && m.state === "active"
      })
    const deadline = Date.now() + 1000
    while (!hasActive() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(hasActive()).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })
})
