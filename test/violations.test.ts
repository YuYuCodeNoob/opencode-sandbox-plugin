import { describe, expect, it } from "bun:test"
import { ViolationReporter } from "../src/violations"

function fakeStore() {
  const listeners: Array<(v: any[]) => void> = []
  const violations: any[] = []
  return {
    listeners,
    violations,
    subscribe: (fn: any) => {
      listeners.push(fn)
      return () => {}
    },
    getViolations: (limit?: number) => (limit ? violations.slice(-limit) : [...violations]),
  }
}

describe("ViolationReporter", () => {
  it("shows a warning toast for a new violation", () => {
    const toasts: unknown[] = []
    const client = { tui: { showToast: async (p: any) => { toasts.push(p); return {} } } }
    const store = fakeStore()
    const reporter = new ViolationReporter(client as any, store as any)
    reporter.start()
    store.listeners[0]!([{ line: "denied write to /etc/passwd", timestamp: new Date() }])
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ variant: "warning", title: "Sandbox violation", message: "denied write to /etc/passwd" })
  })

  it("does not re-toast the same violation on later notifications", () => {
    const toasts: unknown[] = []
    const client = { tui: { showToast: async (p: any) => { toasts.push(p); return {} } } }
    const store = fakeStore()
    const reporter = new ViolationReporter(client as any, store as any)
    reporter.start()
    const v = { line: "denied write to /etc/passwd", timestamp: new Date("2026-01-01T00:00:00Z") }
    store.listeners[0]!([v])
    store.listeners[0]!([v])
    expect(toasts).toHaveLength(1)
  })

  it("is idempotent across start() calls", () => {
    const client = { tui: { showToast: async () => ({}) } }
    const store = fakeStore()
    const reporter = new ViolationReporter(client as any, store as any)
    reporter.start()
    reporter.start()
    expect(store.listeners).toHaveLength(1)
  })

  it("exposes recent violations for the status tool", () => {
    const client = { tui: { showToast: async () => ({}) } }
    const store = fakeStore()
    store.violations.push({ line: "denied read of ~/.ssh/id_rsa", timestamp: new Date("2026-01-01T00:00:00Z") })
    const reporter = new ViolationReporter(client as any, store as any)
    const recent = reporter.recent(10)
    expect(recent).toHaveLength(1)
    expect(recent[0]!.line).toBe("denied read of ~/.ssh/id_rsa")
  })
})
