import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SandboxPolicyStore } from "../src/policy-store"

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "sbx-policy-")) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const globalPath = () => path.join(dir, "global.json")
const projectPath = () => path.join(dir, "project.json")

describe("SandboxPolicyStore", () => {
  it("defaults to sandbox disabled with safe filesystem defaults", async () => {
    const store = new SandboxPolicyStore({ globalPath: globalPath(), projectPath: projectPath() })
    const policy = await store.load()
    expect(policy.enabledByDefault).toBe(false)
    expect(policy.filesystem.denyRead).toContain("~/.ssh")
    expect(policy.network.strictAllowlist).toBe(false)
  })

  it("merges project over global", async () => {
    await writeFile(globalPath(), JSON.stringify({ enabledByDefault: true, network: { allowedDomains: ["a.com"] } }))
    await writeFile(projectPath(), JSON.stringify({ network: { allowedDomains: ["b.com"] } }))
    const store = new SandboxPolicyStore({ globalPath: globalPath(), projectPath: projectPath() })
    const policy = await store.load()
    expect(policy.enabledByDefault).toBe(true)            // inherited from global
    expect(policy.network.allowedDomains).toEqual(["b.com"]) // overridden by project
  })

  it("runtime override wins over persisted enabledByDefault", async () => {
    const store = new SandboxPolicyStore({ globalPath: globalPath(), projectPath: projectPath() })
    await store.setGlobal({ enabledByDefault: true })
    store.setRuntimeOverride(false)
    expect(await store.effectiveEnabled()).toBe(false)
  })

  it("persists global changes to disk", async () => {
    const store = new SandboxPolicyStore({ globalPath: globalPath(), projectPath: projectPath() })
    await store.setGlobal({ filesystem: { allowWrite: ["/tmp/x"] } })
    const onDisk = JSON.parse(await readFile(globalPath(), "utf-8"))
    expect(onDisk.filesystem.allowWrite).toEqual(["/tmp/x"])
  })
})
