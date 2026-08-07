import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Redactor } from "../src/redactor"
import { SandboxPolicyStore } from "../src/policy-store"
import { createSandboxPlugin } from "../src/plugin"
import type { RedactionPattern } from "../src/types"
import type { SandboxManagerLike } from "../src/types"
import type { V2ClientLike } from "../src/transparency"

const FAKE = {
  openai: "sk-projabcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ",
  anthropic: "sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_",
  aws: "AKIAIOSFODNN7EXAMPLE",
  github: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  githubServer: "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
  slack: "xoxb-1234567890-abcdefghij-ABCDEFGHIJ",
  google: "AIzaSyAabcdefghijklmnopqrstuvwxyz012345",
}

const PATTERNS: RedactionPattern[] = [
  { name: "openai_api_key", pattern: "sk-[a-zA-Z0-9]{20,}" },
  { name: "anthropic_api_key", pattern: "sk-ant-[a-zA-Z0-9_\\-]{50,}" },
  { name: "aws_access_key_id", pattern: "AKIA[0-9A-Z]{16}" },
  { name: "github_pat", pattern: "gh[ps]_[A-Za-z0-9]{36}" },
  { name: "slack_token", pattern: "xox[baprs]-[a-zA-Z0-9\\-]+" },
  { name: "google_api_key", pattern: "AIza[0-9A-Za-z_\\-]{35}" },
]

describe("Redactor — constructor", () => {
  it("compiles valid patterns and masks matching text", () => {
    const r = new Redactor([{ name: "openai", pattern: "sk-[a-zA-Z0-9]{20,}" }])
    const result = r.apply(`key=${FAKE.openai}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toContain("[REDACTED:openai]")
    expect(result.output).not.toContain(FAKE.openai)
  })

  it("silently skips invalid regex patterns", () => {
    const r = new Redactor([
      { name: "bad", pattern: "(?i)invalid[" },
      { name: "good", pattern: "sk-[a-zA-Z0-9]{20,}" },
    ])
    const result = r.apply(`key=${FAKE.openai}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toContain("[REDACTED:good]")
  })

  it("handles empty pattern list (no masking)", () => {
    const r = new Redactor([])
    const result = r.apply(FAKE.openai)
    expect(result.maskedCount).toBe(0)
    expect(result.output).toBe(FAKE.openai)
  })

  it("handles all-invalid patterns gracefully", () => {
    const r = new Redactor([
      { name: "bad1", pattern: "(?i)invalid[" },
      { name: "bad2", pattern: "unclosed[" },
    ])
    const result = r.apply("some text")
    expect(result.maskedCount).toBe(0)
    expect(result.output).toBe("some text")
  })
})

describe("Redactor — individual secret types", () => {
  it("masks OpenAI API key", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`OPENAI_API_KEY=${FAKE.openai}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("OPENAI_API_KEY=[REDACTED:openai_api_key]")
  })

  it("masks Anthropic API key", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`ANTHROPIC_KEY=${FAKE.anthropic}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("ANTHROPIC_KEY=[REDACTED:anthropic_api_key]")
  })

  it("masks AWS access key ID", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`aws_access_key_id = ${FAKE.aws}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("aws_access_key_id = [REDACTED:aws_access_key_id]")
  })

  it("masks GitHub PAT (ghp_)", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`GITHUB_TOKEN=${FAKE.github}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("GITHUB_TOKEN=[REDACTED:github_pat]")
  })

  it("masks GitHub server token (ghs_)", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`token: ${FAKE.githubServer}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("token: [REDACTED:github_pat]")
  })

  it("masks Slack token", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`SLACK_TOKEN=${FAKE.slack}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("SLACK_TOKEN=[REDACTED:slack_token]")
  })

  it("masks Google API key", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`GOOGLE_API_KEY=${FAKE.google}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("GOOGLE_API_KEY=[REDACTED:google_api_key]")
  })
})

describe("Redactor — multiple secrets", () => {
  it("masks multiple different secrets in one text", () => {
    const text = [
      `openai: ${FAKE.openai}`,
      `aws: ${FAKE.aws}`,
      `github: ${FAKE.github}`,
    ].join("\n")
    const r = new Redactor(PATTERNS)
    const result = r.apply(text)
    expect(result.maskedCount).toBe(3)
    expect(result.output).toContain("[REDACTED:openai_api_key]")
    expect(result.output).toContain("[REDACTED:aws_access_key_id]")
    expect(result.output).toContain("[REDACTED:github_pat]")
    expect(result.output).not.toContain(FAKE.openai)
    expect(result.output).not.toContain(FAKE.aws)
    expect(result.output).not.toContain(FAKE.github)
  })

  it("masks multiple occurrences of same pattern", () => {
    const text = `${FAKE.openai} and ${FAKE.openai}`
    const r = new Redactor(PATTERNS)
    const result = r.apply(text)
    expect(result.maskedCount).toBe(2)
    expect(result.output).toBe("[REDACTED:openai_api_key] and [REDACTED:openai_api_key]")
  })

  it("masks all six secret types simultaneously", () => {
    const text = [
      FAKE.openai,
      FAKE.anthropic,
      FAKE.aws,
      FAKE.github,
      FAKE.slack,
      FAKE.google,
    ].join("\n")
    const r = new Redactor(PATTERNS)
    const result = r.apply(text)
    expect(result.maskedCount).toBe(6)
    for (const v of Object.values(FAKE)) {
      expect(result.output).not.toContain(v)
    }
  })

  it("preserves non-secret surrounding text", () => {
    const text = `Line 1\nAPI key is ${FAKE.openai}\nLine 3`
    const r = new Redactor(PATTERNS)
    const result = r.apply(text)
    expect(result.output).toBe("Line 1\nAPI key is [REDACTED:openai_api_key]\nLine 3")
  })
})

describe("Redactor — no-match scenarios", () => {
  it("returns text unchanged when no secrets present", () => {
    const text = "just some normal text without any secrets"
    const r = new Redactor(PATTERNS)
    const result = r.apply(text)
    expect(result.maskedCount).toBe(0)
    expect(result.output).toBe(text)
  })

  it("does not mask short strings that look like keys", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply("sk-abcde")
    expect(result.maskedCount).toBe(0)
    expect(result.output).toBe("sk-abcde")
  })

  it("does not mask short AWS-like strings", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply("AKIASHORT")
    expect(result.maskedCount).toBe(0)
    expect(result.output).toBe("AKIASHORT")
  })

  it("does not mask non-token xox strings", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply("xoxx-not-a-token")
    expect(result.maskedCount).toBe(0)
    expect(result.output).toBe("xoxx-not-a-token")
  })
})

describe("Redactor — custom replacement", () => {
  it("uses custom replacement string", () => {
    const r = new Redactor([
      { name: "test", pattern: "sk-[a-zA-Z0-9]{20,}", replacement: "***HIDDEN***" },
    ])
    const result = r.apply(`key=${FAKE.openai}`)
    expect(result.output).toBe("key=***HIDDEN***")
    expect(result.output).not.toContain("[REDACTED")
  })

  it("uses different replacements for different patterns", () => {
    const r = new Redactor([
      { name: "openai", pattern: "sk-[a-zA-Z0-9]{20,}", replacement: "[OPENAI_HIDDEN]" },
      { name: "aws", pattern: "AKIA[0-9A-Z]{16}", replacement: "[AWS_HIDDEN]" },
    ])
    const result = r.apply(`${FAKE.openai} ${FAKE.aws}`)
    expect(result.output).toBe("[OPENAI_HIDDEN] [AWS_HIDDEN]")
    expect(result.maskedCount).toBe(2)
  })
})

describe("Redactor — default policy patterns", () => {
  const store = new SandboxPolicyStore({ globalPath: "/dev/null", projectPath: "/dev/null" })
  const defaults = store.defaultPolicy().redaction

  it("has redaction disabled by default", () => {
    expect(defaults.enabled).toBe(false)
  })

  it("targets read, grep, bash by default", () => {
    expect(defaults.tools).toEqual(["read", "grep", "bash"])
  })

  it("includes 7 default patterns", () => {
    expect(defaults.patterns).toHaveLength(7)
  })

  it("includes all expected pattern names", () => {
    const names = defaults.patterns.map((p) => p.name)
    expect(names).toContain("openai_api_key")
    expect(names).toContain("anthropic_api_key")
    expect(names).toContain("aws_access_key_id")
    expect(names).toContain("github_pat")
    expect(names).toContain("slack_token")
    expect(names).toContain("google_api_key")
    expect(names).toContain("generic_secret_assign")
  })

  it("default patterns mask OpenAI key", () => {
    const r = new Redactor(defaults.patterns)
    const result = r.apply(`key=${FAKE.openai}`)
    expect(result.maskedCount).toBeGreaterThan(0)
    expect(result.output).not.toContain(FAKE.openai)
  })

  it("default patterns mask Anthropic key", () => {
    const r = new Redactor(defaults.patterns)
    const result = r.apply(`anthropic=${FAKE.anthropic}`)
    expect(result.maskedCount).toBeGreaterThan(0)
    expect(result.output).not.toContain(FAKE.anthropic)
  })

  it("default patterns mask AWS key", () => {
    const r = new Redactor(defaults.patterns)
    const result = r.apply(`aws=${FAKE.aws}`)
    expect(result.maskedCount).toBeGreaterThan(0)
    expect(result.output).not.toContain(FAKE.aws)
  })

  it("default patterns mask GitHub PAT", () => {
    const r = new Redactor(defaults.patterns)
    const result = r.apply(`gh=${FAKE.github}`)
    expect(result.maskedCount).toBeGreaterThan(0)
    expect(result.output).not.toContain(FAKE.github)
  })

  it("default patterns mask Slack token", () => {
    const r = new Redactor(defaults.patterns)
    const result = r.apply(`slack=${FAKE.slack}`)
    expect(result.maskedCount).toBeGreaterThan(0)
    expect(result.output).not.toContain(FAKE.slack)
  })

  it("default patterns mask Google API key", () => {
    const r = new Redactor(defaults.patterns)
    const result = r.apply(`google=${FAKE.google}`)
    expect(result.maskedCount).toBeGreaterThan(0)
    expect(result.output).not.toContain(FAKE.google)
  })
})

describe("Redactor — realistic scenarios", () => {
  it("masks secrets in .env file content", () => {
    const envContent = [
      "# Environment variables",
      `OPENAI_API_KEY=${FAKE.openai}`,
      `AWS_ACCESS_KEY_ID=${FAKE.aws}`,
      `GITHUB_TOKEN=${FAKE.github}`,
      "PORT=3000",
      `SLACK_TOKEN=${FAKE.slack}`,
    ].join("\n")
    const r = new Redactor(PATTERNS)
    const result = r.apply(envContent)
    expect(result.maskedCount).toBe(4)
    expect(result.output).toContain("PORT=3000")
    expect(result.output).toContain("[REDACTED:openai_api_key]")
    expect(result.output).toContain("[REDACTED:aws_access_key_id]")
    expect(result.output).toContain("[REDACTED:github_pat]")
    expect(result.output).toContain("[REDACTED:slack_token]")
  })

  it("masks secrets in JSON config", () => {
    const json = JSON.stringify(
      {
        api_key: FAKE.openai,
        region: "us-east-1",
        aws_key: FAKE.aws,
      },
      null,
      2,
    )
    const r = new Redactor(PATTERNS)
    const result = r.apply(json)
    expect(result.maskedCount).toBe(2)
    expect(result.output).toContain("[REDACTED:openai_api_key]")
    expect(result.output).toContain("[REDACTED:aws_access_key_id]")
    expect(result.output).toContain("us-east-1")
  })

  it("masks secrets in shell output", () => {
    const output = `Configuration loaded.\nToken: ${FAKE.slack}\nRegion: us-west-2\nKey: ${FAKE.google}`
    const r = new Redactor(PATTERNS)
    const result = r.apply(output)
    expect(result.maskedCount).toBe(2)
    expect(result.output).toContain("us-west-2")
    expect(result.output).toContain("[REDACTED:slack_token]")
    expect(result.output).toContain("[REDACTED:google_api_key]")
  })

  it("masks secrets in log output", () => {
    const log = `[2024-01-01 10:00:00] INFO: Using API key ${FAKE.openai} for request\n[2024-01-01 10:00:01] INFO: Response received`
    const r = new Redactor(PATTERNS)
    const result = r.apply(log)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toContain("[REDACTED:openai_api_key]")
    expect(result.output).toContain("Response received")
    expect(result.output).not.toContain(FAKE.openai)
  })

  it("masks secrets in multi-line config with comments", () => {
    const content = [
      "# AWS credentials",
      `export AWS_ACCESS_KEY_ID=${FAKE.aws}`,
      "",
      "# GitHub",
      `export GITHUB_TOKEN=${FAKE.github}`,
      "",
      "# OpenAI",
      `export OPENAI_API_KEY=${FAKE.openai}`,
    ].join("\n")
    const r = new Redactor(PATTERNS)
    const result = r.apply(content)
    expect(result.maskedCount).toBe(3)
    expect(result.output).toContain("# AWS credentials")
    expect(result.output).toContain("# GitHub")
    expect(result.output).toContain("# OpenAI")
    expect(result.output).not.toContain(FAKE.aws)
    expect(result.output).not.toContain(FAKE.github)
    expect(result.output).not.toContain(FAKE.openai)
  })
})

describe("Redactor — edge cases", () => {
  it("handles empty string input", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply("")
    expect(result.maskedCount).toBe(0)
    expect(result.output).toBe("")
  })

  it("handles whitespace-only input", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply("   \n\t  ")
    expect(result.maskedCount).toBe(0)
    expect(result.output).toBe("   \n\t  ")
  })

  it("does not double-mask already-redacted output", () => {
    const r = new Redactor(PATTERNS)
    const first = r.apply(`key=${FAKE.openai}`)
    const second = r.apply(first.output)
    expect(second.maskedCount).toBe(0)
    expect(second.output).toBe(first.output)
  })

  it("masks secret at start of string", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`${FAKE.openai} is the key`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("[REDACTED:openai_api_key] is the key")
  })

  it("masks secret at end of string", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`the key is ${FAKE.openai}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("the key is [REDACTED:openai_api_key]")
  })

  it("masks secret spanning entire string", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(FAKE.openai)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("[REDACTED:openai_api_key]")
  })

  it("masks secrets separated by single space", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`${FAKE.openai} ${FAKE.aws}`)
    expect(result.maskedCount).toBe(2)
    expect(result.output).toBe("[REDACTED:openai_api_key] [REDACTED:aws_access_key_id]")
  })

  it("masks secrets on adjacent lines", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`${FAKE.openai}\n${FAKE.aws}`)
    expect(result.maskedCount).toBe(2)
    expect(result.output).toBe("[REDACTED:openai_api_key]\n[REDACTED:aws_access_key_id]")
  })
})

describe("Redactor — pattern boundary behavior", () => {
  it("masks secret embedded in URL", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`https://api.openai.com/v1?key=${FAKE.openai}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("https://api.openai.com/v1?key=[REDACTED:openai_api_key]")
  })

  it("masks secret in JSON string value", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`{"token": "${FAKE.slack}"}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe('{"token": "[REDACTED:slack_token]"}')
  })

  it("masks secret in single-quoted string", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`key='${FAKE.openai}'`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("key='[REDACTED:openai_api_key]'")
  })

  it("masks secret in base64-like context", () => {
    const r = new Redactor(PATTERNS)
    const result = r.apply(`Authorization: Bearer ${FAKE.openai}`)
    expect(result.maskedCount).toBe(1)
    expect(result.output).toBe("Authorization: Bearer [REDACTED:openai_api_key]")
  })
})

describe("Redactor — plugin integration (tool.execute.after)", () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  function fakeManager(): SandboxManagerLike {
    return {
      async initialize() {},
      isSupportedPlatform() { return true },
      checkDependencies() { return { ok: true, missing: [] } },
      async wrapWithSandbox(cmd: string) { return `w(${cmd})` },
      updateConfig() {},
      async reset() {},
    }
  }

  async function makePluginWithRedaction(globalPath: string) {
    const dir = await mkdtemp(path.join(tmpdir(), "sbx-red-"))
    dirs.push(dir)
    const client: V2ClientLike = {
      session: { messages: async () => [], message: async () => ({}) },
      part: { update: async () => ({}) },
      permission: { reply: async () => ({}) },
      tui: { showToast: async () => ({}), publish: async () => ({}) },
    }
    const hooks = createSandboxPlugin(
      { directory: "/work", serverUrl: new URL("http://localhost:4096"), client } as any,
      {
        manager: fakeManager(),
        globalConfigPath: globalPath,
        projectConfigPath: path.join(dir, "p.json"),
        client,
      },
    )
    return { hooks, dir }
  }

  it("masks secrets in read tool output when redaction is enabled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbx-red-cfg-"))
    dirs.push(dir)
    const globalPath = path.join(dir, "config.json")
    await writeFile(
      globalPath,
      JSON.stringify({
        redaction: {
          enabled: true,
          tools: ["read"],
          patterns: [
            { name: "openai_api_key", pattern: "sk-[a-zA-Z0-9]{20,}" },
            { name: "aws_access_key_id", pattern: "AKIA[0-9A-Z]{16}" },
          ],
        },
      }),
    )
    const { hooks } = await makePluginWithRedaction(globalPath)
    await new Promise((r) => setTimeout(r, 200))

    const output = { output: `file content with key=${FAKE.openai}`, title: "read" }
    await hooks["tool.execute.after"]?.({ tool: "read", sessionID: "s1", callID: "c1", args: {} }, output as any)
    expect(output.output).toContain("[REDACTED:openai_api_key]")
    expect(output.output).not.toContain(FAKE.openai)
  })

  it("does not mask when redaction is disabled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbx-red-dis-"))
    dirs.push(dir)
    const globalPath = path.join(dir, "config.json")
    await writeFile(globalPath, JSON.stringify({ redaction: { enabled: false } }))
    const { hooks } = await makePluginWithRedaction(globalPath)
    await new Promise((r) => setTimeout(r, 200))

    const output = { output: `key=${FAKE.openai}`, title: "read" }
    await hooks["tool.execute.after"]?.({ tool: "read", sessionID: "s2", callID: "c2", args: {} }, output as any)
    expect(output.output).toContain(FAKE.openai)
    expect(output.output).not.toContain("[REDACTED")
  })

  it("only masks tools listed in redaction.tools", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbx-red-tools-"))
    dirs.push(dir)
    const globalPath = path.join(dir, "config.json")
    await writeFile(
      globalPath,
      JSON.stringify({
        redaction: {
          enabled: true,
          tools: ["read"],
          patterns: [{ name: "openai_api_key", pattern: "sk-[a-zA-Z0-9]{20,}" }],
        },
      }),
    )
    const { hooks } = await makePluginWithRedaction(globalPath)
    await new Promise((r) => setTimeout(r, 200))

    // "bash" is NOT in redaction.tools → should NOT be masked
    const bashOutput = { output: `bash output: ${FAKE.openai}`, title: "bash" }
    await hooks["tool.execute.after"]?.({ tool: "bash", sessionID: "s3", callID: "c3", args: {} }, bashOutput as any)
    expect(bashOutput.output).toContain(FAKE.openai)
    expect(bashOutput.output).not.toContain("[REDACTED")

    // "read" IS in redaction.tools → should be masked
    const readOutput = { output: `read output: ${FAKE.openai}`, title: "read" }
    await hooks["tool.execute.after"]?.({ tool: "read", sessionID: "s4", callID: "c4", args: {} }, readOutput as any)
    expect(readOutput.output).toContain("[REDACTED:openai_api_key]")
    expect(readOutput.output).not.toContain(FAKE.openai)
  })

  it("masks multiple secrets in a single tool output", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbx-red-multi-"))
    dirs.push(dir)
    const globalPath = path.join(dir, "config.json")
    await writeFile(
      globalPath,
      JSON.stringify({
        redaction: {
          enabled: true,
          tools: ["read"],
          patterns: PATTERNS,
        },
      }),
    )
    const { hooks } = await makePluginWithRedaction(globalPath)
    await new Promise((r) => setTimeout(r, 200))

    const content = `config:\n  openai: ${FAKE.openai}\n  aws: ${FAKE.aws}\n  github: ${FAKE.github}`
    const output = { output: content, title: "read" }
    await hooks["tool.execute.after"]?.({ tool: "read", sessionID: "s5", callID: "c5", args: {} }, output as any)
    expect(output.output).toContain("[REDACTED:openai_api_key]")
    expect(output.output).toContain("[REDACTED:aws_access_key_id]")
    expect(output.output).toContain("[REDACTED:github_pat]")
    expect(output.output).not.toContain(FAKE.openai)
    expect(output.output).not.toContain(FAKE.aws)
    expect(output.output).not.toContain(FAKE.github)
  })

  it("leaves non-secret text unchanged in tool output", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbx-red-clean-"))
    dirs.push(dir)
    const globalPath = path.join(dir, "config.json")
    await writeFile(
      globalPath,
      JSON.stringify({
        redaction: {
          enabled: true,
          tools: ["read"],
          patterns: [{ name: "openai_api_key", pattern: "sk-[a-zA-Z0-9]{20,}" }],
        },
      }),
    )
    const { hooks } = await makePluginWithRedaction(globalPath)
    await new Promise((r) => setTimeout(r, 200))

    const cleanText = "This is a normal file with no secrets.\nLine 2\nLine 3"
    const output = { output: cleanText, title: "read" }
    await hooks["tool.execute.after"]?.({ tool: "read", sessionID: "s6", callID: "c6", args: {} }, output as any)
    expect(output.output).toBe(cleanText)
  })
})
