import type { PluginInput } from "@opencode-ai/plugin"
import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import { createSandboxPlugin } from "./plugin"
import os from "node:os"
import path from "node:path"

export { createSandboxPlugin } from "./plugin"
export { SandboxPolicyStore } from "./policy-store"
export { SandboxRuntimeAdapter } from "./adapter"
export { SandboxController } from "./controller"
export { TransparencyRepair } from "./transparency"
export { Redactor } from "./redactor"
export * from "./types"

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
