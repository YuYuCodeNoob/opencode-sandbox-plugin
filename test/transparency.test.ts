import { describe, expect, it } from "bun:test"
import { TransparencyRepair } from "../src/transparency"

function part(callID = "c1", command = "bwrap ... echo hello") {
  return {
    id: "p1",
    type: "tool",
    callID,
    tool: "bash",
    state: { input: { command }, status: "completed" },
  }
}

function message(id = "m1", parts: any[] = [part()]) {
  return { info: { id }, parts }
}

/** v2 client mock：`session.messages` 返回裸数组（旧测试兼容）。 */
function messagesClient(parts: any[] = [part()], messageID = "m1") {
  const updated: unknown[] = []
  const client = {
    session: {
      messages: async () => [message(messageID, parts)],
      message: async () => ({}),
    },
    part: {
      update: async (params: any) => {
        updated.push(params)
        return {}
      },
    },
  }
  return { client, updated }
}

/** v2 client mock：`session.messages` 返回 `{ data, request, response }` 包装（真实 v2 SDK 形状）。 */
function wrappedClient(parts: any[] = [part()]) {
  const updated: unknown[] = []
  const client = {
    session: {
      messages: async () => ({ data: [message("m1", parts)], request: {}, response: {} }),
      message: async () => ({}),
    },
    part: {
      update: async (params: any) => {
        updated.push(params)
        return {}
      },
    },
  }
  return { client, updated }
}

/** v2 client mock：messageID 命中时 `session.message` 返回 `{ data, ... }` 包装。 */
function hintedClient(parts: any[] = [part()], hintMessageID = "m2") {
  const updated: unknown[] = []
  let messagesCalls = 0
  const client = {
    session: {
      messages: async () => {
        messagesCalls += 1
        return { data: [message("m1", parts)], request: {}, response: {} }
      },
      message: async ({ messageID }: any) =>
        messageID === hintMessageID ? { data: message(hintMessageID, parts), request: {}, response: {} } : {},
    },
    part: {
      update: async (params: any) => {
        updated.push(params)
        return {}
      },
    },
  }
  return { client, updated, messagesCalls: () => messagesCalls }
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

  it("unwraps the v2 { data } response shape from session.messages", async () => {
    const r = new TransparencyRepair()
    r.register("c1", "echo hello")
    const { client, updated } = wrappedClient()
    await r.repair(client as any, "s1", "c1")

    expect(updated).toHaveLength(1)
    expect((updated[0] as any).part.state.input.command).toBe("echo hello")
  })

  it("uses the messageID hint to locate the part without scanning the full session", async () => {
    const r = new TransparencyRepair()
    r.register("c1", "echo hello")
    const { client, updated, messagesCalls } = hintedClient([part("c1")], "m2")
    await r.repair(client as any, "s1", "c1", "m2")

    expect(updated).toHaveLength(1)
    expect((updated[0] as any).messageID).toBe("m2")
    expect(messagesCalls()).toBe(0) // 提示路径命中，未走全量扫描
  })

  it("falls back to the full scan when the messageID hint misses", async () => {
    const r = new TransparencyRepair()
    r.register("c1", "echo hello")
    const { client, updated, messagesCalls } = hintedClient([part("c1")], "m2") // 只有 m2 命中提示路径
    await r.repair(client as any, "s1", "c1", "wrong-hint")

    expect(updated).toHaveLength(1)
    expect((updated[0] as any).messageID).toBe("m1") // 回退全量扫描找到
    expect(messagesCalls()).toBe(1)
  })

  it("does nothing when the part cannot be found", async () => {
    const r = new TransparencyRepair()
    r.register("c1", "echo hello")
    const { client } = messagesClient([part("other")]) // no matching part
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
        message: async () => ({}),
        part: { update: async () => ({}) },
      },
    }
    await r.repair(client as any, "s1", "c1")
    expect(r.takeOriginal("c1")).toBeUndefined()
  })
})
