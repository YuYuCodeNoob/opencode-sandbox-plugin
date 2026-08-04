import type { PluginInput } from "@opencode-ai/plugin"

export default {
  server: async (input: PluginInput) => {
    void input
    return {}
  },
}
