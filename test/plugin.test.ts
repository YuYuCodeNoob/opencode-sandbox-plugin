import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createSandboxPlugin, createV2Client } from "../src/plugin"
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
    session: {
      messages: async () => [],
      message: async () => ({}),
    },
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

describe("createV2Client in-process fetch extraction", () => {
  it("reuses the in-process fetch from input.client (compiled-build transport)", async () => {
    // 编译版 opencode：Server.url undefined → serverUrl 回退死端口；input.client
    // 由 opencode 注入进程内 fetch（Server.Default().app.fetch）。v2 client 必须
    // 复用该 fetch，否则 part.update 会挂死在 localhost:4096。
    const reached: string[] = []
    const inProcessFetch = async (req: Request): Promise<Response> => {
      reached.push(`${req.method} ${new URL(req.url).pathname}`)
      if (new URL(req.url).pathname.startsWith("/session/")) {
        return new Response(
          JSON.stringify([{ info: { id: "m1" }, parts: [{ id: "p1", type: "tool", callID: "c1", state: { input: { command: "wrapped" } } }] }]),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404 })
    }
    const fakeV1Client = { _client: { getConfig: () => ({ fetch: inProcessFetch }) } }
    const client = createV2Client({ client: fakeV1Client, directory: "/work", serverUrl: new URL("http://localhost:4096") } as any)

    const res = await (client as any).session.messages({ sessionID: "s1" })
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data[0].info.id).toBe("m1")
    expect(reached).toContain("GET /session/s1/message") // 走进程内 fetch，而非网络
  })

  it("falls back to HTTP when input.client exposes no fetch (source build / mocks)", () => {
    const client = createV2Client({ client: {}, directory: "/work", serverUrl: new URL("http://localhost:4096") } as any)
    expect(client).toBeDefined()
  })
})

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
