import { describe, expect, it } from "bun:test"
import { decodeTuiCommand, encodeTuiCommand } from "../src/tui-protocol"

describe("tui-protocol", () => {
  it("round-trips every command shape", () => {
    const cmds = [
      { v: 1 as const, cmd: "sandbox.get" as const },
      { v: 1 as const, cmd: "sandbox.toggle" as const },
      { v: 1 as const, cmd: "sandbox.allow" as const, id: "a1", host: "h.com", persist: false, scope: "global" as const },
      { v: 1 as const, cmd: "sandbox.allow" as const, id: "a2", host: "h.com", persist: true, scope: "project" as const },
      { v: 1 as const, cmd: "sandbox.deny" as const, id: "a3", host: "h.com" },
      {
        v: 1 as const,
        cmd: "sandbox.state" as const,
        state: "active" as const,
        enabled: true,
        source: "override" as const,
        override: true,
        activeChildren: 2,
        pendingRefresh: false,
        lastError: null,
      },
      { v: 1 as const, cmd: "sandbox.ask" as const, id: "a4", host: "h.com", port: 443, timeoutMs: 15_000 },
      { v: 1 as const, cmd: "sandbox.ask.resolved" as const, id: "a4", allowed: true },
    ]
    for (const cmd of cmds) {
      expect(decodeTuiCommand(encodeTuiCommand(cmd))).toEqual(cmd)
    }
  })

  it("returns undefined for non-JSON, wrong version, or unknown cmd", () => {
    expect(decodeTuiCommand("not json")).toBeUndefined()
    expect(decodeTuiCommand("")).toBeUndefined()
    expect(decodeTuiCommand(JSON.stringify({ v: 2, cmd: "sandbox.toggle" }))).toBeUndefined()
    expect(decodeTuiCommand(JSON.stringify({ v: 1, cmd: "something.else" }))).toBeUndefined()
    expect(decodeTuiCommand(JSON.stringify({ cmd: "sandbox.toggle" }))).toBeUndefined() // missing v
    expect(decodeTuiCommand(JSON.stringify("sandbox.toggle"))).toBeUndefined() // not an object
  })
})
