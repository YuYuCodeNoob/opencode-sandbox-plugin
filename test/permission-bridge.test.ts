import { describe, expect, it } from "bun:test"
import { PermissionBridge } from "../src/permission-bridge"

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
})
