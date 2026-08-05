import { describe, expect, it } from "bun:test"
import { PermissionBridge } from "../src/permission-bridge"
import type { SandboxTuiCommand } from "../src/tui-protocol"

function fakeClient() {
  const toasts: unknown[] = []
  const client = {
    tui: {
      showToast: async (p: any) => {
        toasts.push(p)
        return {}
      },
    },
  }
  return { client, toasts }
}

function capturePublish() {
  const published: SandboxTuiCommand[] = []
  return {
    published,
    publish: (cmd: SandboxTuiCommand) => {
      published.push(cmd)
    },
  }
}

describe("PermissionBridge (waiting semi-interactive)", () => {
  it("resolves true when the host is allowed", async () => {
    const { client } = fakeClient()
    const bridge = new PermissionBridge(client as any, { timeoutMs: 5000 })
    const p = bridge.handleAsk({ host: "api.example.com", port: 443, sessionID: "s1" })
    expect(bridge.getPendingCount()).toBe(1)
    expect(bridge.allow("api.example.com")).toBe(true)
    expect(await p).toBe(true)
    expect(bridge.getPendingCount()).toBe(0)
  })

  it("dedupes concurrent asks for the same host into one toast", async () => {
    const { client, toasts } = fakeClient()
    const bridge = new PermissionBridge(client as any, { timeoutMs: 5000 })
    const p1 = bridge.handleAsk({ host: "h.com", port: 443, sessionID: "s1" })
    const p2 = bridge.handleAsk({ host: "h.com", port: 80, sessionID: "s1" })
    expect(toasts).toHaveLength(1) // one prompt, not two
    bridge.allow("h.com")
    expect(await p1).toBe(true)
    expect(await p2).toBe(true)
    expect(bridge.getPendingCount()).toBe(0)
  })

  it("resolves false on timeout", async () => {
    const { client } = fakeClient()
    const bridge = new PermissionBridge(client as any, { timeoutMs: 10 })
    const p = bridge.handleAsk({ host: "h.com", port: 443, sessionID: "s1" })
    expect(await p).toBe(false)
    expect(bridge.getPendingCount()).toBe(0)
  })

  it("resolves false on deny", async () => {
    const { client } = fakeClient()
    const bridge = new PermissionBridge(client as any, { timeoutMs: 5000 })
    const p = bridge.handleAsk({ host: "h.com", port: 443, sessionID: "s1" })
    bridge.deny("h.com")
    expect(await p).toBe(false)
  })

  it("allow() returns false when nothing is pending", () => {
    const { client } = fakeClient()
    const bridge = new PermissionBridge(client as any)
    expect(bridge.allow("h.com")).toBe(false)
  })

  it("shows a toast with the host label", async () => {
    const { client, toasts } = fakeClient()
    const bridge = new PermissionBridge(client as any, { timeoutMs: 5000 })
    void bridge.handleAsk({ host: "api.example.com", port: 443, sessionID: "s1" })
    expect(toasts).toHaveLength(1)
    const toast = toasts[0] as any
    expect(toast.variant).toBe("warning")
    expect(toast.message).toContain("api.example.com")
  })

  it("publishes a sandbox.ask event with a stable id on handleAsk", async () => {
    const { client } = fakeClient()
    const { published, publish } = capturePublish()
    const bridge = new PermissionBridge(client as any, { publish, timeoutMs: 5000 })
    const p = bridge.handleAsk({ host: "api.example.com", port: 443, sessionID: "s1" })
    expect(published).toHaveLength(1)
    const ask = published[0]!
    expect(ask.cmd).toBe("sandbox.ask")
    if (ask.cmd !== "sandbox.ask") return
    expect(ask.host).toBe("api.example.com")
    expect(ask.port).toBe(443)
    // resolve by that same id (TUI round-trip)
    expect(bridge.resolve(ask.id, { allow: true, persist: false })).toBe(true)
    expect(await p).toBe(true)
  })

  it("publishes sandbox.ask.resolved when settled (including timeout)", async () => {
    const { client } = fakeClient()
    const { published, publish } = capturePublish()
    const bridge = new PermissionBridge(client as any, { publish, timeoutMs: 5000 })
    void bridge.handleAsk({ host: "h.com", port: 443, sessionID: "s1" })
    expect(bridge.allow("h.com")).toBe(true)
    expect(published).toHaveLength(2)
    expect(published[1]!.cmd).toBe("sandbox.ask.resolved")
  })

  it("resolve with persist triggers onAllowNetwork (Always allow)", async () => {
    const { client } = fakeClient()
    const { published, publish } = capturePublish()
    const allowed: Array<[string, string]> = []
    const bridge = new PermissionBridge(client as any, {
      publish,
      onAllowNetwork: (host, scope) => {
        allowed.push([host, scope])
      },
    })
    const p = bridge.handleAsk({ host: "h.com", port: 443, sessionID: "s1" })
    const ask = published[0]!
    if (ask.cmd !== "sandbox.ask") return
    bridge.resolve(ask.id, { allow: true, persist: true, scope: "global" })
    expect(await p).toBe(true)
    expect(allowed).toEqual([["h.com", "global"]])
  })

  it("resolve without persist does NOT touch the allowlist (Allow once)", async () => {
    const { client } = fakeClient()
    const { published, publish } = capturePublish()
    const allowed: Array<[string, string]> = []
    const bridge = new PermissionBridge(client as any, {
      publish,
      onAllowNetwork: (host, scope) => {
        allowed.push([host, scope])
      },
    })
    const p = bridge.handleAsk({ host: "h.com", port: 443, sessionID: "s1" })
    const ask = published[0]!
    if (ask.cmd !== "sandbox.ask") return
    bridge.resolve(ask.id, { allow: true, persist: false })
    expect(await p).toBe(true)
    expect(allowed).toEqual([]) // no allowlist write
  })

  it("resolve returns false for an unknown id (already timed out)", () => {
    const { client } = fakeClient()
    const bridge = new PermissionBridge(client as any, { timeoutMs: 5000 })
    expect(bridge.resolve("does-not-exist", { allow: true })).toBe(false)
  })
})
