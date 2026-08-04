import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SandboxPolicy } from "./types"

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  // Arrays and scalars replace wholesale; only plain objects deep-merge.
  if (!isRecord(base) || !isRecord(patch)) return (patch as T) ?? base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isRecord(value) && isRecord(base[key]) ? deepMerge(base[key], value) : value
  }
  return out as T
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
