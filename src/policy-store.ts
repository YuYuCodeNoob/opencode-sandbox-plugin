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
      redaction: {
        enabled: false,
        tools: ["read", "grep", "bash"],
        patterns: [
          { name: "openai_api_key", pattern: "sk-[a-zA-Z0-9]{20,}" },
          { name: "anthropic_api_key", pattern: "sk-ant-[a-zA-Z0-9_\\-]{50,}" },
          { name: "aws_access_key_id", pattern: "AKIA[0-9A-Z]{16}" },
          { name: "github_pat", pattern: "gh[ps]_[A-Za-z0-9]{36}" },
          { name: "slack_token", pattern: "xox[baprs]-[a-zA-Z0-9\\-]+" },
          { name: "google_api_key", pattern: "AIza[0-9A-Za-z_\\-]{35}" },
          { name: "generic_secret_assign", pattern: "(?i)(?:api[_-]?key|secret|token|password)\\s*[:=]\\s*['\"]?[a-zA-Z0-9_\\-]{32,}['\"]?" },
        ],
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

  /** Append a domain to the target file's own allowedDomains (deepMerge replaces arrays, so we must read+append+write). */
  async addAllowedDomain(host: string, scope: "project" | "global"): Promise<void> {
    await this.appendDomain("allowedDomains", host, scope)
  }

  /** Append a domain to the target file's own deniedDomains. */
  async addDeniedDomain(host: string, scope: "project" | "global"): Promise<void> {
    await this.appendDomain("deniedDomains", host, scope)
  }

  private async appendDomain(field: "allowedDomains" | "deniedDomains", host: string, scope: "project" | "global"): Promise<void> {
    const target = scope === "global" ? this.opts.globalPath : this.opts.projectPath
    const current = await this.readJSON(target)
    const network = isRecord(current.network) ? (current.network as Record<string, unknown>) : {}
    const arr = Array.isArray(network[field]) ? (network[field] as string[]) : []
    if (!arr.includes(host)) arr.push(host)
    await this.writeJSON(target, { ...current, network: { ...network, [field]: arr } })
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
