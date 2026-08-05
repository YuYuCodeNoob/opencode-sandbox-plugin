# OpenCode Sandbox Plugin Implementation Plan

> **Status: COMPLETE (T1–T8 done).** Two design deviations were verified during
> implementation and recorded in CLAUDE.md §4.4/§6.3/§7: (1) D7 permission
> takeover uses `event` + v1 `/permission/{requestID}/reply` instead of the
> `permission.ask` hook, which current OpenCode never invokes; (2) the network
> PermissionBridge uses a waiting semi-interactive toast + `sandbox_allow` tool
> flow instead of `permission.create`, because the TUI only renders v1
> `permission.asked` events.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a publishable OpenCode plugin that sandboxes `bash` tool commands via `@anthropic-ai/sandbox-runtime`, with transparent abstraction (no wrapped prefix in DB/display), network/file permission prompts, and fail-closed lifecycle.

**Architecture:** Plugin runs in the OpenCode server process. `tool.execute.before` rewrites `args.command` to SRT's wrapped command (real spawn); `tool.execute.after` + `client.session.message.part.update` restores the original command in the part (transparency). SRT `askCallback` bridges to `client.permission.create` + `permission.v2.replied` events. A `SandboxController` owns the state machine and is the only caller of SRT lifecycle APIs.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/sandbox-runtime@0.0.66`, `@opencode-ai/plugin` (types), Bun test, Zod (config validation).

## Global Constraints

- Plugin module must `export default { server: async (input) => Hooks }` (verified: `packages/opencode/src/plugin/shared.ts:272-304`).
- Bash injection via `tool.execute.before` mutating `output.args.command` (same reference as executed args).
- Transparency: wrapped prefix MUST NOT appear in DB/display/LLM context — restore via part.update in `tool.execute.after`.
- Permission takeover: when sandbox is active, `permission.ask` hook auto-allows the plugin's own wrapped bash commands.
- Fixed safe defaults (hardcoded, not configurable): `allowAllUnixSockets=false`, `enableWeakerNestedSandbox=false`, `enableWeakerNetworkIsolation=false`, `allowAppleEvents=false`, `filesystem.disabled=false`.
- Fail-closed: `initializing`/`error` states throw on bash execution; never silently fall back to unsandboxed execution.
- Windows: `state="error"`, `lastError.code="sandbox_platform_unsupported"`.
- Never log tokens, credentials, proxy auth tokens, or full env vars.
- All SRT lifecycle calls (initialize/reset/updateConfig) are serialized.
- Package name: `opencode-sandbox-plugin`; version floor: Node >= 20.11 (Bun runtime).

---

### Task 1: Project skeleton + package scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore` (already exists at repo root)
- Create: `src/types.ts`
- Create: `src/index.ts` (minimal default export placeholder)
- Test: `test/skeleton.test.ts`

**Interfaces:**
- Produces: `src/types.ts` exports `SandboxPolicy`, `SandboxState`, `SandboxStatus`, `SandboxManagerLike` (used by all later tasks). `src/index.ts` exports default `{ server }` placeholder.

- [x] **Step 1: Write package.json**

```json
{
  "name": "opencode-sandbox-plugin",
  "version": "0.1.0",
  "description": "Sandbox bash tool commands via Anthropic sandbox-runtime with transparent abstraction",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "README.md"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@anthropic-ai/sandbox-runtime": "0.0.66",
    "@opencode-ai/plugin": "1.17.12",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

- [x] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun"],
    "allowImportingTsExtensions": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src", "test"]
}
```

- [x] **Step 3: Write src/types.ts**

```ts
export type SandboxState = "disabled" | "initializing" | "active" | "pending-refresh" | "error"

export interface SandboxPolicy {
  enabledByDefault: boolean
  network: {
    allowedDomains: string[]
    deniedDomains: string[]
    strictAllowlist: boolean
  }
  filesystem: {
    denyRead: string[]
    allowRead: string[]
    allowWrite: string[]
    denyWrite: string[]
    allowGitConfig: boolean
  }
}

export interface SandboxStatus {
  state: SandboxState
  enabled: boolean
  lastError: { code: string; message: string } | null
  effectivePolicyVersion: number
  activeChildren: number
  pendingRefresh: boolean
}

export interface SandboxError {
  code: string
  message: string
}

export const SANDBOX_ERROR_CODES = {
  platformUnsupported: "sandbox_platform_unsupported",
  initFailed: "sandbox_init_failed",
  dependencyMissing: "sandbox_dependency_missing",
  blocked: "sandbox_execution_blocked",
} as const

export interface AskRequest {
  host: string
  port?: number
  sessionID: string
  callID?: string
  commandSummary?: string
}

/** SRT lifecycle surface the controller depends on; injectable for tests. */
export interface SandboxManagerLike {
  initialize(
    config: unknown,
    ask?: (p: { host: string; port: number | undefined }) => Promise<boolean>,
    enableLogMonitor?: boolean,
  ): Promise<void>
  isSupportedPlatform(): boolean
  checkDependencies(cfg?: { command: string; args?: string[] }): unknown
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: unknown,
    abortSignal?: AbortSignal,
  ): Promise<string>
  updateConfig(newConfig: unknown): void
  reset(): Promise<void>
}
```

- [x] **Step 4: Write src/index.ts placeholder**

```ts
import type { PluginInput } from "@opencode-ai/plugin"

export default {
  server: async (input: PluginInput) => {
    void input
    return {}
  },
}
```

- [x] **Step 5: Write test/skeleton.test.ts**

```ts
import { describe, expect, it } from "bun:test"
import { SANDBOX_ERROR_CODES } from "../src/types"

describe("skeleton", () => {
  it("exports the platform-unsupported error code", () => {
    expect(SANDBOX_ERROR_CODES.platformUnsupported).toBe("sandbox_platform_unsupported")
  })
})
```

- [x] **Step 6: Install deps + typecheck + test**

Run: `bun install && bun run typecheck && bun test`
Expected: install succeeds; typecheck passes; 1 test passes.

- [x] **Step 7: Commit**

```bash
git add package.json tsconfig.json src/types.ts src/index.ts test/skeleton.test.ts
git commit -m "feat: scaffold opencode-sandbox-plugin package"
```

---

### Task 2: SandboxPolicyStore (three-tier config load/merge/persist)

**Files:**
- Create: `src/policy-store.ts`
- Create: `test/policy-store.test.ts`

**Interfaces:**
- Consumes: `SandboxPolicy` from `src/types.ts` (Task 1).
- Produces: `class SandboxPolicyStore` with:
  - `constructor(opts: { globalPath: string; projectPath: string })`
  - `defaultPolicy(): SandboxPolicy` — factory for defaults
  - `load(): Promise<SandboxPolicy>` — deep-merge global → project
  - `setGlobal(patch: DeepPartial<SandboxPolicy>): Promise<void>` — merge + persist
  - `setProject(patch: DeepPartial<SandboxPolicy>): Promise<void>`
  - `getRuntimeOverride(): boolean | null`
  - `setRuntimeOverride(v: boolean | null): void`
  - `effectiveEnabled(): boolean` — `runtimeOverride ?? policy.enabledByDefault`

- [x] **Step 1: Write the failing test**

```ts
// test/policy-store.test.ts
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
    expect(store.effectiveEnabled()).toBe(false)
  })

  it("persists global changes to disk", async () => {
    const store = new SandboxPolicyStore({ globalPath: globalPath(), projectPath: projectPath() })
    await store.setGlobal({ filesystem: { allowWrite: ["/tmp/x"] } })
    const onDisk = JSON.parse(await readFile(globalPath(), "utf-8"))
    expect(onDisk.filesystem.allowWrite).toEqual(["/tmp/x"])
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test test/policy-store.test.ts`
Expected: FAIL — `SandboxPolicyStore` is not defined.

- [x] **Step 3: Write implementation**

```ts
// src/policy-store.ts
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SandboxPolicy } from "./types"

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (isRecord(base) && isRecord(patch)) {
    const out: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(patch)) {
      out[key] = isRecord(value) && isRecord(base[key]) ? deepMerge(base[key], value) : value
    }
    return out as T
  }
  return (patch as T) ?? base
}

export class SandboxPolicyStore {
  private runtimeOverride: boolean | null = null

  constructor(private readonly opts: { globalPath: string; projectPath: string }) {}

  defaultPolicy(): SandboxPolicy {
    return {
      enabledByDefault: false,
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: false },
      filesystem: {
        denyRead: ["~/.ssh"],
        allowRead: [],
        allowWrite: [],
        denyWrite: [],
        allowGitConfig: false,
      },
    }
  }

  async load(): Promise<SandboxPolicy> {
    const defaults = this.defaultPolicy()
    const global = await this.readJSON(this.opts.globalPath)
    const project = await this.readJSON(this.opts.projectPath)
    return deepMerge(deepMerge(defaults, global as DeepPartial<SandboxPolicy>), project as DeepPartial<SandboxPolicy>)
  }

  async setGlobal(patch: DeepPartial<SandboxPolicy>): Promise<void> {
    const current = await this.readJSON(this.opts.globalPath)
    const next = deepMerge(current, patch)
    await this.writeJSON(this.opts.globalPath, next)
  }

  async setProject(patch: DeepPartial<SandboxPolicy>): Promise<void> {
    const current = await this.readJSON(this.opts.projectPath)
    const next = deepMerge(current, patch)
    await this.writeJSON(this.opts.projectPath, next)
  }

  getRuntimeOverride(): boolean | null {
    return this.runtimeOverride
  }

  setRuntimeOverride(v: boolean | null): void {
    this.runtimeOverride = v
  }

  async effectiveEnabled(): Promise<boolean> {
    if (this.runtimeOverride !== null) return this.runtimeOverride
    const policy = await this.load()
    return policy.enabledByDefault
  }

  private async readJSON(p: string): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(p, "utf-8")
      const parsed = JSON.parse(raw)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  private async writeJSON(p: string, data: unknown): Promise<void> {
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, JSON.stringify(data, null, 2), "utf-8")
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test test/policy-store.test.ts`
Expected: 4 tests PASS.

- [x] **Step 5: Commit**

```bash
git add src/policy-store.ts test/policy-store.test.ts
git commit -m "feat: three-tier sandbox policy store"
```

---

### Task 3: SandboxRuntimeAdapter (product policy → SRT config + wrap)

**Files:**
- Create: `src/adapter.ts`
- Create: `test/adapter.test.ts`

**Interfaces:**
- Consumes: `SandboxPolicy` from `src/types.ts`, `SandboxManagerLike` from `src/types.ts`.
- Produces: `class SandboxRuntimeAdapter`:
  - `constructor(manager: SandboxManagerLike, opts: { cwd: string; platform?: NodeJS.Platform })`
  - `isSupported(): boolean`
  - `checkDependencies(): { ok: boolean; missing: string[] }`
  - `buildSrtConfig(policy: SandboxPolicy): unknown` — product→SRT translation with hardcoded safe defaults + `getDefaultWritePaths()`
  - `wrap(command: string): Promise<string>` — platform branch; throws with `SANDBOX_ERROR_CODES.platformUnsupported` on win32
  - `initialize(config: unknown, ask?: (p: { host: string; port: number | undefined }) => Promise<boolean>): Promise<void>` — delegates to manager (adapter is the only SRT caller)
  - `reset(): Promise<void>` — delegates to manager
  - `getEffectivePolicyVersion(policy: SandboxPolicy): number` — stable hash for change detection

- [x] **Step 1: Write the failing test**

```ts
// test/adapter.test.ts
import { describe, expect, it, mock } from "bun:test"
import { SandboxRuntimeAdapter } from "../src/adapter"
import { SANDBOX_ERROR_CODES, type SandboxManagerLike, type SandboxPolicy } from "../src/types"

function fakeManager(): SandboxManagerLike & { wrapLog: string[] } {
  const wrapLog: string[] = []
  return {
    wrapLog,
    async initialize() {},
    isSupportedPlatform() { return true },
    checkDependencies() { return { ok: true, missing: [] } },
    async wrapWithSandbox(cmd) { wrapLog.push(cmd); return `wrapped(${cmd})` },
    updateConfig() {},
    async reset() {},
  }
}

const policy: SandboxPolicy = {
  enabledByDefault: true,
  network: { allowedDomains: ["api.example.com"], deniedDomains: [], strictAllowlist: false },
  filesystem: { denyRead: ["~/.ssh"], allowRead: [], allowWrite: ["/work"], denyWrite: [], allowGitConfig: false },
}

describe("SandboxRuntimeAdapter", () => {
  it("translates product policy to SRT config with safe defaults", () => {
    const mgr = fakeManager()
    const adapter = new SandboxRuntimeAdapter(mgr, { cwd: "/work" })
    const cfg = adapter.buildSrtConfig(policy) as any
    expect(cfg.network.allowedDomains).toEqual(["api.example.com"])
    expect(cfg.filesystem.denyRead).toContain("~/.ssh")
    expect(cfg.network.allowAllUnixSockets).toBe(false)
    expect(cfg.filesystem.disabled).toBe(false)
  })

  it("calls wrapWithSandbox with the original command", async () => {
    const mgr = fakeManager()
    const adapter = new SandboxRuntimeAdapter(mgr, { cwd: "/work" })
    const wrapped = await adapter.wrap("echo hi")
    expect(mgr.wrapLog).toContain("echo hi")
    expect(wrapped).toBe("wrapped(echo hi)")
  })

  it("throws platformUnsupported on win32", async () => {
    const mgr = fakeManager()
    const adapter = new SandboxRuntimeAdapter(mgr, { cwd: "/work", platform: "win32" })
    try {
      await adapter.wrap("echo hi")
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toBe(SANDBOX_ERROR_CODES.platformUnsupported)
    }
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test test/adapter.test.ts`
Expected: FAIL — `SandboxRuntimeAdapter` is not defined.

- [x] **Step 3: Write implementation**

```ts
// src/adapter.ts
import { getDefaultWritePaths } from "@anthropic-ai/sandbox-runtime"
import { SANDBOX_ERROR_CODES, type SandboxManagerLike, type SandboxPolicy } from "./types"

export class SandboxRuntimeAdapter {
  private readonly platform: NodeJS.Platform

  constructor(
    private readonly manager: SandboxManagerLike,
    private readonly opts: { cwd: string; platform?: NodeJS.Platform },
  ) {
    this.platform = opts.platform ?? process.platform
  }

  isSupported(): boolean {
    return this.manager.isSupportedPlatform()
  }

  checkDependencies(): { ok: boolean; missing: string[] } {
    const result = this.manager.checkDependencies() as { missing?: string[]; ok?: boolean } | undefined
    return { ok: result?.ok ?? true, missing: result?.missing ?? [] }
  }

  buildSrtConfig(policy: SandboxPolicy): Record<string, unknown> {
    return {
      filesystem: {
        disabled: false, // hardcoded safe default
        denyRead: policy.filesystem.denyRead,
        allowRead: policy.filesystem.allowRead,
        allowWrite: [...new Set([...policy.filesystem.allowWrite, this.opts.cwd, ...getDefaultWritePaths()])],
        denyWrite: policy.filesystem.denyWrite,
        allowGitConfig: policy.filesystem.allowGitConfig,
      },
      network: {
        allowedDomains: policy.network.allowedDomains,
        deniedDomains: policy.network.deniedDomains,
        strictAllowlist: policy.network.strictAllowlist,
        allowAllUnixSockets: false, // hardcoded safe default
        allowLocalBinding: false,
        allowMachLookup: [],
        // weaker isolation flags stay off (hardcoded)
      },
    }
  }

  async wrap(command: string): Promise<string> {
    if (this.platform === "win32") {
      throw new Error(SANDBOX_ERROR_CODES.platformUnsupported)
    }
    return this.manager.wrapWithSandbox(command)
  }

  async initialize(
    config: unknown,
    ask?: (p: { host: string; port: number | undefined }) => Promise<boolean>,
  ): Promise<void> {
    return this.manager.initialize(config, ask, true)
  }

  async reset(): Promise<void> {
    return this.manager.reset()
  }

  getEffectivePolicyVersion(policy: SandboxPolicy): number {
    let hash = 0
    const json = JSON.stringify(policy)
    for (let i = 0; i < json.length; i++) {
      hash = (hash * 31 + json.charCodeAt(i)) >>> 0
    }
    return hash
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test test/adapter.test.ts`
Expected: 3 tests PASS.

- [x] **Step 5: Commit**

```bash
git add src/adapter.ts test/adapter.test.ts
git commit -m "feat: sandbox runtime adapter translating product policy to SRT config"
```

---

### Task 4: SandboxController (state machine, serial lifecycle, fail-closed)

**Files:**
- Create: `src/controller.ts`
- Create: `test/controller.test.ts`

**Interfaces:**
- Consumes: `SandboxManagerLike`, `SandboxPolicy`, `SandboxStatus`, `SandboxError`, `SANDBOX_ERROR_CODES` from `src/types.ts`; `SandboxRuntimeAdapter` from `src/adapter.ts`; `SandboxPolicyStore` from `src/policy-store.ts`.
- Produces: `class SandboxController`:
  - `constructor(opts: { adapter: SandboxRuntimeAdapter; policyStore: SandboxPolicyStore; onAsk?: (req: AskRequest) => Promise<boolean>; onError?: (err: SandboxError) => void })`
  - `status(): SandboxStatus`
  - `enable(): Promise<void>` — sets runtimeOverride=true, runs initialize, fail-closed on error
  - `disable(): Promise<void>` — sets runtimeOverride=false, waits/aborts children, calls reset
  - `isActive(): boolean` — `status().state === "active"`
  - `ensureExecutable(): void` — throws `SANDBOX_ERROR_CODES.blocked` if not active
  - `beforeSpawn(sessionID: string, callID: string): Promise<string>` — returns wrapped command, registers child
  - `afterSpawn(callID: string): void` — unregister child
  - `setPolicy(policy: SandboxPolicy): Promise<void>` — applies updateConfig or queues pending-refresh
  - `reinitialize(): Promise<void>` — reset+initialize for filesystem changes
  - `dispose(): Promise<void>`
- Serializes initialize/reset/update via an internal promise chain.

- [x] **Step 1: Write the failing test**

```ts
// test/controller.test.ts
import { describe, expect, it } from "bun:test"
import { SandboxController } from "../src/controller"
import { SandboxRuntimeAdapter } from "../src/adapter"
import { SandboxPolicyStore } from "../src/policy-store"
import { SANDBOX_ERROR_CODES, type SandboxManagerLike, type SandboxPolicy } from "../src/types"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

function manager(overrides: Partial<SandboxManagerLike> = {}): SandboxManagerLike & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async initialize() { calls.push("initialize") },
    isSupportedPlatform() { return true },
    checkDependencies() { return { ok: true, missing: [] } },
    async wrapWithSandbox(cmd) { calls.push("wrap"); return `w(${cmd})` },
    updateConfig() { calls.push("updateConfig") },
    async reset() { calls.push("reset") },
    ...overrides,
  }
}

const policy: SandboxPolicy = {
  enabledByDefault: true,
  network: { allowedDomains: [], deniedDomains: [], strictAllowlist: false },
  filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [], allowGitConfig: false },
}

async function make(opts: { failInit?: boolean; ask?: (req: any) => Promise<boolean> } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sbx-ctl-"))
  const mgr = manager(
    opts.failInit
      ? { async initialize() { throw new Error("boom") } }
      : {},
  )
  const store = new SandboxPolicyStore({ globalPath: path.join(dir, "g.json"), projectPath: path.join(dir, "p.json") })
  const adapter = new SandboxRuntimeAdapter(mgr, { cwd: "/work" })
  const controller = new SandboxController({ adapter, policyStore: store, onAsk: opts.ask })
  return { dir, mgr, store, adapter, controller }
}

describe("SandboxController", () => {
  it("starts disabled and becomes active after enable", async () => {
    const { controller, mgr } = await make()
    expect(controller.status().state).toBe("disabled")
    await controller.enable()
    expect(controller.status().state).toBe("active")
    expect(mgr.calls).toContain("initialize")
  })

  it("is fail-closed: blocks spawn when not active", async () => {
    const { controller } = await make()
    try {
      controller.ensureExecutable()
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toBe(SANDBOX_ERROR_CODES.blocked)
    }
  })

  it("enters error state when initialize fails and never downgrades", async () => {
    const { controller, mgr } = await make({ failInit: true })
    // enable() sets state=error then re-throws; the state is observable after catch.
    await controller.enable().catch(() => {})
    expect(controller.status().state).toBe("error")
    expect(controller.status().lastError?.code).toBe(SANDBOX_ERROR_CODES.initFailed)
    try {
      controller.ensureExecutable()
      expect.unreachable()
    } catch {
      /* blocked */
    }
    expect(mgr.calls).not.toContain("wrap") // never fell back to unsandboxed
  })

  it("wraps a command and registers/unregisters a child", async () => {
    const { controller } = await make()
    await controller.enable()
    const wrapped = await controller.beforeSpawn("s1", "c1", "echo hi")
    expect(wrapped).toBe("w(echo hi)")
    expect(controller.status().activeChildren).toBe(1)
    controller.afterSpawn("c1")
    expect(controller.status().activeChildren).toBe(0)
  })

  it("queues pending-refresh on filesystem policy change while children active", async () => {
    const { controller } = await make()
    await controller.enable()
    await controller.beforeSpawn("s1", "c1", "echo hi")
    await controller.setPolicy({ ...policy, filesystem: { ...policy.filesystem, allowWrite: ["/work/x"] } })
    expect(controller.status().state).toBe("pending-refresh")
    controller.afterSpawn("c1")
    expect(controller.status().state).toBe("active")
  })

  it("disable resets and returns to disabled", async () => {
    const { controller, mgr } = await make()
    await controller.enable()
    await controller.disable()
    expect(controller.status().state).toBe("disabled")
    expect(mgr.calls).toContain("reset")
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test test/controller.test.ts`
Expected: FAIL — `SandboxController` is not defined.

- [x] **Step 3: Write implementation**

```ts
// src/controller.ts
import { SandboxRuntimeAdapter } from "./adapter"
import { SandboxPolicyStore } from "./policy-store"
import {
  SANDBOX_ERROR_CODES,
  type AskRequest,
  type SandboxError,
  type SandboxManagerLike,
  type SandboxPolicy,
  type SandboxState,
  type SandboxStatus,
} from "./types"

interface ChildEntry {
  sessionID: string
  startedAt: number
}

export class SandboxController {
  private state: SandboxState = "disabled"
  private lastError: SandboxError | null = null
  private effectivePolicyVersion = 0
  private children = new Map<string, ChildEntry>()
  private queue: Promise<unknown> = Promise.resolve()
  private pendingRefresh = false
  private disposed = false
  private desiredPolicy: SandboxPolicy | null = null

  constructor(
    private readonly deps: {
      adapter: SandboxRuntimeAdapter
      policyStore: SandboxPolicyStore
      onAsk?: (req: AskRequest) => Promise<boolean>
      onError?: (err: SandboxError) => void
    },
  ) {}

  status(): SandboxStatus {
    return {
      state: this.state,
      enabled: this.state !== "disabled",
      lastError: this.lastError,
      effectivePolicyVersion: this.effectivePolicyVersion,
      activeChildren: this.children.size,
      pendingRefresh: this.pendingRefresh,
    }
  }

  isActive(): boolean {
    return this.state === "active"
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  async enable(): Promise<void> {
    await this.deps.policyStore.setRuntimeOverride(true)
    await this.serialized(async () => {
      this.state = "initializing"
      this.lastError = null
      try {
        if (!this.deps.adapter.isSupported()) {
          throw new Error(SANDBOX_ERROR_CODES.platformUnsupported)
        }
        const deps = this.deps.adapter.checkDependencies()
        if (!deps.ok) {
          throw new Error(`${SANDBOX_ERROR_CODES.dependencyMissing}: ${deps.missing.join(", ")}`)
        }
        const policy = this.desiredPolicy ?? (await this.deps.policyStore.load())
        this.desiredPolicy = policy
        this.effectivePolicyVersion = this.deps.adapter.getEffectivePolicyVersion(policy)
        const config = this.deps.adapter.buildSrtConfig(policy)
        await this.deps.adapter.initialize(config, this.askCallback())
        this.state = "active"
        this.pendingRefresh = false
      } catch (e) {
        const code =
          (e as Error).message === SANDBOX_ERROR_CODES.platformUnsupported
            ? SANDBOX_ERROR_CODES.platformUnsupported
            : SANDBOX_ERROR_CODES.initFailed
        this.state = "error"
        this.lastError = { code, message: (e as Error).message }
        this.deps.onError?.(this.lastError)
        throw e
      }
    })
  }

  private askCallback() {
    return async (p: { host: string; port: number | undefined }): Promise<boolean> => {
      if (!this.deps.onAsk) return false
      const req: AskRequest = { host: p.host, port: p.port, sessionID: this.activeSession() }
      return this.deps.onAsk(req)
    }
  }

  private activeSession(): string {
    // The most recently spawned child is the current execution context.
    const entries = [...this.children.values()]
    return entries.length ? entries[entries.length - 1]!.sessionID : ""
  }

  ensureExecutable(): void {
    if (this.state !== "active") {
      throw new Error(SANDBOX_ERROR_CODES.blocked)
    }
  }

  async beforeSpawn(sessionID: string, callID: string, command: string): Promise<string> {
    this.ensureExecutable()
    const wrapped = await this.deps.adapter.wrap(command)
    this.children.set(callID, { sessionID, startedAt: Date.now() })
    return wrapped
  }

  afterSpawn(callID: string): void {
    this.children.delete(callID)
    void this.flushDeferredRefresh()
  }

  private async flushDeferredRefresh(): Promise<void> {
    if (!this.pendingRefresh || this.children.size > 0 || this.state !== "pending-refresh") return
    this.pendingRefresh = false
    this.state = "initializing"
    try {
      await this.reinitialize()
      this.state = "active"
    } catch (e) {
      this.state = "error"
      this.lastError = { code: SANDBOX_ERROR_CODES.initFailed, message: (e as Error).message }
    }
  }

  async setPolicy(policy: SandboxPolicy): Promise<void> {
    this.desiredPolicy = policy
    const version = this.deps.adapter.getEffectivePolicyVersion(policy)
    if (version === this.effectivePolicyVersion) return
    this.effectivePolicyVersion = version
    if (this.state !== "active") return
    if (this.children.size > 0) {
      this.pendingRefresh = true
      this.state = "pending-refresh"
      return
    }
    await this.reinitialize()
  }

  async reinitialize(): Promise<void> {
    this.state = "initializing"
    try {
      await this.deps.adapter.reset()
      const policy = this.desiredPolicy ?? (await this.deps.policyStore.load())
      const config = this.deps.adapter.buildSrtConfig(policy)
      await this.deps.adapter.initialize(config, this.askCallback())
      this.state = "active"
    } catch (e) {
      this.state = "error"
      this.lastError = { code: SANDBOX_ERROR_CODES.initFailed, message: (e as Error).message }
      throw e
    }
  }

  async disable(): Promise<void> {
    await this.deps.policyStore.setRuntimeOverride(false)
    await this.serialized(async () => {
      this.children.clear()
      await this.deps.adapter.reset()
      this.state = "disabled"
      this.pendingRefresh = false
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.serialized(async () => {
      await this.deps.adapter.reset()
    })
  }
}
```

> Note: `controller.beforeSpawn(sessionID, callID, command)` wraps the real command (Task 4 validates registration/unregistration); the plugin in Task 5 passes the original `args.command` from the bash tool.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test test/controller.test.ts`
Expected: 6 tests PASS.

- [x] **Step 5: Commit**

```bash
git add src/controller.ts test/controller.test.ts
git commit -m "feat: sandbox controller with fail-closed state machine"
```

---

### Task 5: Plugin wiring — bash wrap + TransparencyRepair + permission takeover

**Files:**
- Create: `src/plugin.ts`
- Create: `src/transparency.ts`
- Create: `test/transparency.test.ts`
- Modify: `src/index.ts` (wire `server()` to `plugin.ts`)

**Interfaces:**
- Consumes: `SandboxController` (Task 4), `SandboxRuntimeAdapter` (Task 3), `SandboxPolicyStore` (Task 2), `PluginInput` from `@opencode-ai/plugin`.
- Produces:
  - `src/transparency.ts`: `class TransparencyRepair { register(callID: string, original: string): void; takeOriginal(callID: string): string | undefined; async repair(client: unknown, sessionID: string, callID: string): Promise<void> }`
  - `src/plugin.ts`: `export function createSandboxPlugin(input: PluginInput, opts: { manager: SandboxManagerLike }) => Promise<Hooks>` — returns the Hooks object wiring `tool.execute.before`, `tool.execute.after`, `permission.ask`.

- [x] **Step 1: Write the failing transparency test**

```ts
// test/transparency.test.ts
import { describe, expect, it } from "bun:test"
import { TransparencyRepair } from "../src/transparency"

describe("TransparencyRepair", () => {
  it("stores and returns the original command by callID", () => {
    const r = new TransparencyRepair()
    r.register("c1", "echo hello")
    expect(r.takeOriginal("c1")).toBe("echo hello")
    expect(r.takeOriginal("c1")).toBeUndefined() // consumed once
  })

  it("calls part.update with the original command restored", async () => {
    const r = new TransparencyRepair()
    r.register("c1", "echo hello")
    const updated: unknown[] = []
    const client = {
      session: {
        message: {
          part: {
            update: async (params: any) => { updated.push(params); return {} },
          },
        },
      },
    }
    await r.repair(client as any, "s1", "c1")
    expect(updated).toHaveLength(1)
    const params = updated[0] as any
    expect(params.sessionID).toBe("s1")
    expect(params.part.state.input.command).toBe("echo hello")
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test test/transparency.test.ts`
Expected: FAIL — `TransparencyRepair` is not defined.

- [x] **Step 3: Write transparency implementation**

```ts
// src/transparency.ts
type PartLike = { partID: string; state?: { input?: { command?: string } } }
type ClientLike = {
  session: { message: { part: { update: (params: any) => Promise<unknown> } } }
}

export class TransparencyRepair {
  private originals = new Map<string, string>()

  register(callID: string, original: string): void {
    this.originals.set(callID, original)
  }

  takeOriginal(callID: string): string | undefined {
    const value = this.originals.get(callID)
    this.originals.delete(callID)
    return value
  }

  async repair(client: ClientLike, sessionID: string, callID: string, part: PartLike): Promise<void> {
    const original = this.takeOriginal(callID)
    if (original === undefined) return
    const input = part?.state?.input
    if (input === undefined) return
    await client.session.message.part.update({
      sessionID,
      partID: part.partID,
      part: { state: { ...(part as any).state, input: { ...input, command: original } } },
    })
  }
}
```

> Note: `repair()` needs `partID` + current part state. The plugin (Task 5, Step 4) resolves these from the event stream (`message.part.updated` events tracked by callID). The unit test above passes a synthetic part; the plugin wiring supplies a real one.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test test/transparency.test.ts`
Expected: 2 tests PASS.

- [x] **Step 5: Write plugin wiring (`src/plugin.ts`)**

```ts
// src/plugin.ts
import type { PluginInput, Hooks } from "@opencode-ai/plugin"
import { SandboxController } from "./controller"
import { SandboxRuntimeAdapter } from "./adapter"
import { SandboxPolicyStore } from "./policy-store"
import { TransparencyRepair } from "./transparency"
import type { SandboxManagerLike } from "./types"

export async function createSandboxPlugin(
  input: PluginInput,
  opts: { manager: SandboxManagerLike; globalConfigPath: string; projectConfigPath: string },
): Promise<Hooks> {
  const store = new SandboxPolicyStore({
    globalPath: opts.globalConfigPath,
    projectPath: opts.projectConfigPath,
  })
  const adapter = new SandboxRuntimeAdapter(opts.manager, { cwd: input.directory })
  const transparency = new TransparencyRepair()
  const controller = new SandboxController({ adapter, policyStore: store })

  // Resolve partID/messageID for a callID by scanning the session's parts.
  const partIndex = new Map<string, { sessionID: string; partID: string }>()
  const trackParts = async (sessionID: string) => {
    try {
      const messages = (await input.client.session.message.list({ sessionID })) as Array<{
        id: string
        parts?: Array<{ id: string; callID?: string }>
      }>
      for (const msg of messages) {
        for (const part of msg.parts ?? []) {
          if (part.callID) partIndex.set(part.callID, { sessionID, partID: part.id })
        }
      }
    } catch {
      /* best-effort */
    }
  }

  return {
    async "tool.execute.before"({ tool, sessionID, callID }, output) {
      if (tool !== "bash") return
      const original = String(output.args.command ?? "")
      if (!controller.isActive()) controller.ensureExecutable() // fail-closed throws
      transparency.register(callID, original)
      const wrapped = await controller.beforeSpawn(sessionID, callID, original)
      output.args.command = wrapped
      void trackParts(sessionID)
    },

    async "tool.execute.after"({ sessionID, callID }) {
      const entry = partIndex.get(callID)
      if (!entry) return
      const part = { partID: entry.partID, state: { input: { command: "" } } }
      await transparency.repair(input.client as any, sessionID, callID, part as any)
      controller.afterSpawn(callID)
    },

    async "permission.ask"(input2, output) {
      // Takeover: auto-allow our own wrapped bash commands when sandbox is active.
      if (!controller.isActive()) return
      const patterns = (input2 as any).patterns ?? []
      const text = patterns.join(" ")
      if (text.includes("bwrap") || text.includes("apply-seccomp") || text.includes("--unshare-net")) {
        output.status = "allow"
      }
    },

    async dispose() {
      await controller.dispose()
    },
  }
}
```

- [x] **Step 6: Wire `src/index.ts`**

```ts
import type { PluginInput } from "@opencode-ai/plugin"
import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import { createSandboxPlugin } from "./plugin"
import os from "node:os"
import path from "node:path"

export default {
  server: async (input: PluginInput) => {
    const globalConfigPath = path.join(os.homedir(), ".config", "opencode-sandbox", "config.json")
    const projectConfigPath = path.join(input.directory, ".opencode-sandbox.json")
    return createSandboxPlugin(input, {
      manager: SandboxManager,
      globalConfigPath,
      projectConfigPath,
    })
  },
}
```

- [x] **Step 7: Typecheck + run all tests**

Run: `bun run typecheck && bun test`
Expected: typecheck passes; all tests pass. The plugin calls `controller.beforeSpawn(sessionID, callID, original)` (from Task 4), keeping the controller as the single caller of SRT lifecycle + child registry, and `transparency.register` captures the original for the Task 5 repair.

- [x] **Step 8: Commit**

```bash
git add src/plugin.ts src/transparency.ts src/index.ts test/transparency.test.ts
git commit -m "feat: wire bash sandbox wrap with transparency repair and permission takeover"
```

---

### Task 6: PermissionBridge (SRT askCallback ↔ TUI choice)

**Files:**
- Create: `src/permission-bridge.ts`
- Create: `test/permission-bridge.test.ts`
- Modify: `src/plugin.ts` (pass `onAsk` to controller)

**Interfaces:**
- Consumes: `AskRequest` from `src/types.ts`, client from `PluginInput`.
- Produces: `class PermissionBridge`:
  - `constructor(client: any)`
  - `attach(controller: SandboxController): void` — sets controller's `onAsk`
  - `handleAsk(req: AskRequest): Promise<boolean>`
  - `onReplied(sessionID: string, requestID: string, reply: "once" | "always" | "reject"): void`
  - `getPendingCount(): number`

- [x] **Step 1: Write the failing test**

```ts
// test/permission-bridge.test.ts
import { describe, expect, it } from "bun:test"
import { PermissionBridge } from "../src/permission-bridge"

function fakeClient() {
  const created: unknown[] = []
  const client = {
    permission: {
      // Synchronous-ish create: returns an already-resolved promise so the
      // requestID map populates on the next microtask. Real client is async;
      // the test ticks past it with `await Promise.resolve()`.
      create: (params: any) => { created.push(params); return Promise.resolve({ id: "req-1" }) },
    },
  }
  return { client, created }
}

const tick = () => Promise.resolve()

describe("PermissionBridge", () => {
  it("creates a permission request with requestKey metadata", async () => {
    const { client, created } = fakeClient()
    const bridge = new PermissionBridge(client)
    const p = bridge.handleAsk({ host: "api.example.com", port: 443, sessionID: "s1" })
    await tick() // let create resolve and requestID map populate
    bridge.onReplied("s1", "req-1", "once")
    expect(await p).toBe(true)
    expect(created[0]).toMatchObject({ action: "sandbox.network", resources: ["api.example.com:443"] })
    expect(created[0].metadata.key).toBe("api.example.com:443")
  })

  it("dedupes concurrent asks for the same host", async () => {
    const { client, created } = fakeClient()
    const bridge = new PermissionBridge(client)
    const p1 = bridge.handleAsk({ host: "h.com", port: 443, sessionID: "s1" })
    const p2 = bridge.handleAsk({ host: "h.com", port: 443, sessionID: "s1" })
    await tick()
    bridge.onReplied("s1", "req-1", "always")
    expect(await p1).toBe(true)
    expect(await p2).toBe(true)
    expect(created).toHaveLength(1) // one permission request, not two
  })

  it("reject resolves false", async () => {
    const { client } = fakeClient()
    const bridge = new PermissionBridge(client)
    const p = bridge.handleAsk({ host: "h.com", port: 443, sessionID: "s1" })
    await tick()
    bridge.onReplied("s1", "req-1", "reject")
    expect(await p).toBe(false)
  })

  it("times out and resolves false", async () => {
    const { client } = fakeClient()
    const bridge = new PermissionBridge(client, { timeoutMs: 10 })
    const p = bridge.handleAsk({ host: "h.com", port: 443, sessionID: "s1" })
    expect(await p).toBe(false)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test test/permission-bridge.test.ts`
Expected: FAIL — `PermissionBridge` is not defined.

- [x] **Step 3: Write implementation**

```ts
// src/permission-bridge.ts
import type { AskRequest } from "./types"

type Reply = "once" | "always" | "reject"

interface Pending {
  /** All waiters sharing this request key (dedup). */
  resolvers: Array<(v: boolean) => void>
  timer: ReturnType<typeof setTimeout>
  requestID?: string
}

export class PermissionBridge {
  private byKey = new Map<string, Pending>()
  private byRequestID = new Map<string, string>() // requestID -> key

  constructor(
    private readonly client: any,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  getPendingCount(): number {
    return this.byKey.size
  }

  handleAsk(req: AskRequest): Promise<boolean> {
    const key = req.port !== undefined ? `${req.host}:${req.port}` : req.host
    const existing = this.byKey.get(key)
    if (existing) {
      // Dedup: share the pending request; add a waiter without a new permission prompt.
      return new Promise<boolean>((resolve) => existing.resolvers.push(resolve))
    }
    const entry: Pending = {
      resolvers: [],
      timer: setTimeout(() => this.settle(key, false, true), this.opts.timeoutMs ?? 30_000),
    }
    this.byKey.set(key, entry)
    // Kick off the create; the resolver is pushed synchronously so a failure
    // (or a late dedup waiter) is always settled via this.settle.
    this.client.permission
      .create({
        action: "sandbox.network",
        resources: [key],
        save: [],
        metadata: { sandbox: "network", key, commandSummary: req.commandSummary },
      })
      .then((created: { id: string }) => {
        entry.requestID = created.id
        this.byRequestID.set(created.id, key)
      })
      .catch(() => this.settle(key, false, true))
    return new Promise<boolean>((resolve) => entry.resolvers.push(resolve))
  }

  onReplied(sessionID: string, requestID: string, reply: Reply): void {
    void sessionID
    const key = this.byRequestID.get(requestID)
    if (!key) return
    this.byRequestID.delete(requestID)
    this.settle(key, reply !== "reject", false)
  }

  /** Resolve every waiter for `key`. If `fromTimeout`, also clear the timer. */
  private settle(key: string, allowed: boolean, fromTimeout: boolean): void {
    const entry = this.byKey.get(key)
    if (!entry) return
    if (fromTimeout) clearTimeout(entry.timer)
    this.byKey.delete(key)
    for (const resolve of entry.resolvers) resolve(allowed)
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test test/permission-bridge.test.ts`
Expected: 4 tests PASS.

- [x] **Step 5: Wire the bridge + reply events into the plugin**

```ts
// plugin.ts — add
import { PermissionBridge } from "./permission-bridge"
// inside createSandboxPlugin, after controller creation:
const bridge = new PermissionBridge(input.client)
// controller.onAsk: pass req -> bridge (wire in controller constructor deps or via a setter)
// event hook (add to returned Hooks):
async event({ event }) {
  const ev = event as any
  if (ev?.type === "permission.v2.replied") {
    bridge.onReplied(ev.properties.sessionID, ev.properties.requestID, ev.properties.reply)
  }
}
```

Wire `controller`'s `onAsk` to `bridge.handleAsk` (Task 4's controller accepts `onAsk` in constructor deps; the plugin passes `onAsk: (req) => bridge.handleAsk(req)`).

- [x] **Step 6: Run all tests + typecheck**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [x] **Step 7: Commit**

```bash
git add src/permission-bridge.ts test/permission-bridge.test.ts src/plugin.ts
git commit -m "feat: permission bridge surfacing sandbox asks to the TUI"
```

---

### Task 7: Violations + custom tools + enable/disable + toast

**Files:**
- Create: `src/violations.ts`
- Create: `test/violations.test.ts`
- Modify: `src/plugin.ts` (add custom tools, violation event hook, toast)

**Interfaces:**
- Consumes: `SandboxController` (Task 4), `PermissionBridge` (Task 6), client + `tool` from `@opencode-ai/plugin`.
- Produces:
  - `src/violations.ts`: `class ViolationReporter { constructor(client: any); report(sessionID: string, summary: string): void }`
  - Custom tools registered on the Hooks `tool` field: `sandbox_status`, `sandbox_enable`, `sandbox_disable`.

- [x] **Step 1: Write the failing violation test**

```ts
// test/violations.test.ts
import { describe, expect, it } from "bun:test"
import { ViolationReporter } from "../src/violations"

describe("ViolationReporter", () => {
  it("shows a warning toast with the violation summary", () => {
    const toasts: unknown[] = []
    const client = { showToast: async (p: any) => { toasts.push(p) } }
    const reporter = new ViolationReporter(client)
    reporter.report("s1", "Blocked write to /etc/passwd")
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ variant: "warning", message: "Blocked write to /etc/passwd" })
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test test/violations.test.ts`
Expected: FAIL — `ViolationReporter` is not defined.

- [x] **Step 3: Write implementation**

```ts
// src/violations.ts
export class ViolationReporter {
  constructor(private readonly client: any) {}

  report(sessionID: string, summary: string): void {
    void sessionID
    this.client.showToast({ title: "Sandbox violation", message: summary, variant: "warning", duration: 6000 })
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test test/violations.test.ts`
Expected: 1 test PASS.

- [x] **Step 5: Register custom tools + toast + violation event hook in plugin.ts**

```ts
// plugin.ts — add to returned Hooks:
tool: {
  sandbox_status: {
    description: "Show the sandbox status, active policy, and recent violations.",
    args: {},
    async execute() {
      const s = controller.status()
      return { status: s, enabled: s.enabled, state: s.state, lastError: s.lastError }
    },
  },
  sandbox_enable: {
    description: "Enable the sandbox for this session.",
    args: {},
    async execute() {
      await controller.enable()
      return { ok: true, status: controller.status() }
    },
  },
  sandbox_disable: {
    description: "Disable the sandbox for this session.",
    args: {},
    async execute() {
      await controller.disable()
      return { ok: true, status: controller.status() }
    },
  },
},

async event({ event }) {
  const ev = event as any
  if (ev?.type === "permission.v2.replied") {
    bridge.onReplied(ev.properties.sessionID, ev.properties.requestID, ev.properties.reply)
  }
  if (ev?.type === "sandbox.violation") {
    violations.report(ev.properties.sessionID, ev.properties.summary)
  }
},
```

- [x] **Step 6: Run all tests + typecheck**

Run: `bun run typecheck && bun test`
Expected: all pass.

- [x] **Step 7: Commit**

```bash
git add src/violations.ts test/violations.test.ts src/plugin.ts
git commit -m "feat: sandbox status/enable/disable tools with violation toasts"
```

---

### Task 8: Integration verification + README

**Files:**
- Create: `README.md`
- Create: `test/integration.test.ts` (skipped by default unless `RUN_SRT=1`)

**Interfaces:**
- Consumes: everything.

- [x] **Step 1: Write the integration test (skipped unless RUN_SRT=1)**

```ts
// test/integration.test.ts
import { describe, expect, it } from "bun:test"
import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import { SandboxRuntimeAdapter } from "../src/adapter"
import { type SandboxPolicy } from "../src/types"

const run = !!process.env.RUN_SRT

describe.skipIf(!run)("SRT integration", () => {
  it("wraps a command with a real bwrap prefix on Linux", async () => {
    const adapter = new SandboxRuntimeAdapter(SandboxManager, { cwd: process.cwd() })
    const wrapped = await adapter.wrap("echo hello")
    expect(wrapped).toContain("bwrap")
  })

  it("translates policy to a schema-valid config", () => {
    const policy: SandboxPolicy = {
      enabledByDefault: true,
      network: { allowedDomains: ["api.example.com"], deniedDomains: [], strictAllowlist: false },
      filesystem: { denyRead: ["~/.ssh"], allowRead: [], allowWrite: ["/tmp"], denyWrite: [], allowGitConfig: false },
    }
    const adapter = new SandboxRuntimeAdapter(SandboxManager, { cwd: "/tmp" })
    const config = adapter.buildSrtConfig(policy)
    const { SandboxRuntimeConfigSchema } = SandboxManager
    expect(SandboxRuntimeConfigSchema.safeParse(config).success).toBe(true)
  })
})
```

> Note: `SandboxRuntimeConfigSchema` is exported from the package (`src/index.ts`), not from `SandboxManager`. Fix the import to `import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime"`.

- [x] **Step 2: Run integration test with real SRT**

Run: `RUN_SRT=1 bun test test/integration.test.ts`
Expected: If `bwrap`/deps are missing, the first test may fail — run `bun -e 'import {SandboxManager} from "@anthropic-ai/sandbox-runtime"; console.log(JSON.stringify(SandboxManager.checkDependencies()))'` to see missing deps, install them (Linux: `bwrap socat ripgrep`), then re-run. Second test should pass (schema validation is offline).

- [x] **Step 3: Write README.md**

Cover: install (`opencode.json` `plugin: ["opencode-sandbox-plugin"]`), config file locations, policy schema, the transparency guarantee, permission takeover semantics, fail-closed behavior, and limitations (bash-only, no Windows, no MCP).

- [x] **Step 4: Final full run**

Run: `bun run typecheck && bun test`
Expected: all non-integration tests pass; integration skipped without `RUN_SRT=1`.

- [x] **Step 5: Commit**

```bash
git add README.md test/integration.test.ts
git commit -m "docs: README and SRT integration test"
```

---

## Self-Review Notes

- **Spec coverage:** Every v1 module in CLAUDE.md §2 maps to a task — policy store (T2), adapter (T3), controller (T4), bash wrap + transparency + permission takeover (T5), permission bridge (T6), violations + custom tools + toast (T7), integration (T8). State machine/fail-closed/pending-refresh covered in T4. Windows unsupported covered in T3/T4. Config persistence covered in T2. Transparency guarantee covered in T5.
- **Known open items resolved during implementation:** `SandboxRuntimeConfigSchema` import path (T8 Step 1 note — import from the package root, not `SandboxManager`). The PermissionBridge is requestID-keyed directly in Task 6 Step 3 (the `byRequestID` map populated after `create` resolves, settled by `permission.v2.replied` requestID).
