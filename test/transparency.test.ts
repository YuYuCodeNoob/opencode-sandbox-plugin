import { describe, expect, it } from "bun:test"
import { TransparencyRepair } from "../src/transparency"

function messagesClient(part: any = {}) {
  const updated: unknown[] = []
  const client = {
    session: {
      messages: async () => [
        {
          info: { id: "m1" },
          parts: [
            {
              id: "p1",
              type: "tool",
              callID: "c1",
              tool: "bash",
              state: { input: { command: "bwrap ... echo hello" }, status: "completed" },
              ...part,
            },
          ],
        },
      ],
      message: {
        part: {
          update: async (params: any) => {
            updated.push(params)
            return {}
          },
        },
      },
    },
  }
  return { client, updated }
}

describe("TransparencyRepair", () => {
  it("stores and returns the original command by callID (consumed once)", () => {
    const r = new TransparencyRepair()
    r.register("c1", "echo hello")
    expect(r.hasWrapped("c1")).toBe(true)
    expect(r.takeOriginal("c1")).toBe("echo hello")
    expect(r.takeOriginal("c1")).toBeUndefined()
    expect(r.hasWrapped("c1")).toBe(false)
  })

  it("locates the part by callID and restores the original command", async () => {
    const r = new TransparencyRepair()
    r.register("c1", "echo hello")
    const { client, updated } = messagesClient()
    await r.repair(client as any, "s1", "c1")

    expect(updated).toHaveLength(1)
    const params = updated[0] as any
    expect(params.sessionID).toBe("s1")
    expect(params.messageID).toBe("m1")
    expect(params.partID).toBe("p1")
    // Full part sent back (id/messageID/sessionID must match the path for the HTTP handler)
    expect(params.part.id).toBe("p1")
    expect(params.part.messageID).toBe("m1")
    // Command restored; other state preserved
    expect(params.part.state.input.command).toBe("echo hello")
    expect(params.part.state.status).toBe("completed")
  })

  it("does nothing when the part cannot be found", async () => {
    const r = new TransparencyRepair()
    r.register("c1", "echo hello")
    const { client } = messagesClient({ callID: "other" }) // no matching part
    await r.repair(client as any, "s1", "c1") // must not throw
    expect(r.takeOriginal("c1")).toBeUndefined() // original consumed
  })

  it("does nothing when no original was registered", async () => {
    const r = new TransparencyRepair()
    const { client, updated } = messagesClient()
    await r.repair(client as any, "s1", "unknown-call")
    expect(updated).toHaveLength(0)
  })

  it("handles a missing messages endpoint without throwing", async () => {
    const r = new TransparencyRepair()
    r.register("c1", "echo hello")
    const client = {
      session: {
        messages: async () => {
          throw new Error("boom")
        },
        message: { part: { update: async () => ({}) } },
      },
    }
    await r.repair(client as any, "s1", "c1")
    expect(r.takeOriginal("c1")).toBeUndefined()
  })
})
