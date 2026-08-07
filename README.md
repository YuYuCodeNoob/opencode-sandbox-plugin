# OpenCode Sandbox Plugin

`@yuxuanyu/opencode_sandbox_plugin` runs OpenCode's `bash` tool inside a real OS-level boundary provided by [Anthropic Sandbox Runtime](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime).

- Linux: Bubblewrap (`bwrap`) and seccomp
- macOS: Seatbelt
- Windows: unsupported

The plugin has two parts: a server plugin that enforces the sandbox and a TUI plugin that provides human-only controls.

## For Users

### Features

- Sandbox every OpenCode `bash` command when enabled.
- Restrict network access with allowlists, denylists, or interactive approval.
- Restrict filesystem reads and writes.
- Show network approval dialogs in the TUI.
- Toggle the sandbox for the current process from the TUI.
- Mask common API keys, tokens, and passwords in `read`, `grep`, and `bash` output.
- Keep the generated `bwrap` command out of stored tool parts, TUI display, and LLM history.
- Fail closed: if the sandbox is enabled but cannot initialize, `bash` is blocked instead of silently running without isolation.
- Expose only read-only `sandbox_status` to the LLM. Sandbox controls remain human-only.

### Install From npm

Install the package in the normal OpenCode plugin flow. Add the server plugin to `opencode.jsonc`:

```jsonc
{
  "plugin": ["@yuxuanyu/opencode_sandbox_plugin"]
}
```

Add the TUI plugin to `~/.config/opencode/tui.jsonc`:

```jsonc
{
  "plugin": ["@yuxuanyu/opencode_sandbox_plugin"]
}
```

The server plugin and TUI plugin must run on the same machine because they coordinate through a local runtime file. Restart OpenCode after changing plugin configuration.

### Configuration

Policy is merged from these layers, from lowest to highest priority:

| Layer | Location |
| --- | --- |
| Defaults | Built into the plugin |
| Global | `~/.config/opencode-sandbox/config.json` |
| Project | `<project>/.opencode-sandbox.json` |
| Runtime override | In memory, controlled by the TUI toggle |

Objects are deep-merged. Arrays are replaced by the higher-priority layer.

Create a global or project policy such as:

```json
{
  "enabledByDefault": true,
  "network": {
    "allowedDomains": ["api.example.com"],
    "deniedDomains": [],
    "strictAllowlist": false
  },
  "filesystem": {
    "denyRead": ["~/.ssh"],
    "allowRead": [],
    "allowWrite": ["."],
    "denyWrite": [".env"],
    "allowGitConfig": false
  },
  "redaction": {
    "enabled": true,
    "tools": ["read", "grep", "bash"],
    "patterns": [
      {
        "name": "internal_token",
        "pattern": "internal_[A-Za-z0-9_-]{32,}",
        "replacement": "[REDACTED]"
      }
    ]
  }
}
```

Network behavior:

- `allowedDomains`: domains that may be accessed without prompting.
- `deniedDomains`: domains that are always denied and take precedence over the allowlist.
- `strictAllowlist: true`: unlisted domains are denied without a prompt.
- `strictAllowlist: false`: unlisted domains trigger a human approval dialog.
- An approval expires after 15 seconds if no decision is made.
- “Always allow” persists the host in the global allowlist.

Filesystem behavior:

- `denyRead` blocks reads unless explicitly allowed by the runtime policy.
- `allowRead` grants read access to selected paths.
- `allowWrite` limits write access to selected paths.
- `denyWrite` takes precedence over `allowWrite`.
- OpenCode's working directory and SRT temporary paths are required runtime paths.

Redaction behavior:

- Disabled by default.
- Patterns are JavaScript regular expressions supplied as strings.
- A pattern may define a custom `replacement`; otherwise the redactor uses its default mask.
- Redaction applies to tool output, not to the command being executed.

### Usage

The TUI plugin provides a `Sandbox` entry in the bottom-left area. Use it to inspect the current state and toggle the sandbox for the current process. You can also use `/sandbox-toggle` when supported by the host TUI.

Network requests to unlisted hosts open a dialog:

- **Allow once**: allow only the current request.
- **Always allow**: allow the request and persist the host globally.
- **Deny**: reject the request.

The read-only `sandbox_status` tool reports the current state, effective policy source, active child processes, pending network grants, and recent violations.

### States and Fail-Closed Behavior

| State | Behavior |
| --- | --- |
| `disabled` | `bash` runs without this plugin's sandbox. |
| `initializing` | `bash` is blocked until initialization completes. |
| `active` | `bash` runs inside the OS sandbox. |
| `pending-refresh` | Existing processes continue under their current policy; refresh is pending. |
| `error` | `bash` is blocked until the user disables or successfully re-enables the sandbox. |

If sandboxing is enabled but the platform, SRT dependency, or runtime initialization is unavailable, the plugin does not fall back to unsandboxed execution.

### Requirements and Limitations

- Linux requires the SRT runtime dependencies, including `bwrap`, `socat`, and `ripgrep` where applicable.
- macOS uses Seatbelt.
- Windows is not supported.
- Only the `bash` tool is sandboxed. `read`, `edit`, MCP tools, and independently spawned processes are outside this boundary.
- The wrapper command necessarily exists in the actual child process, but the plugin restores the original command in persistent history and LLM context.
- A broad network allowlist can still permit data upload to that domain.
- Without the TUI plugin, pending network requests are denied after the timeout.
- The server and TUI plugins must run on the same machine.

### Troubleshooting

Check these files when diagnosing a local installation:

```text
~/.config/opencode-sandbox/config.json
~/.config/opencode-sandbox/runtime.json
~/.config/opencode-sandbox/debug.log
```

Common checks:

- Confirm both server and TUI plugin entries are present.
- Restart OpenCode after changing configuration.
- If the state is `error`, inspect `lastError` through `sandbox_status` and check that SRT dependencies are installed.
- If an approval dialog does not appear, inspect `runtime.json` and verify that the TUI plugin is loaded.
- If a wrapped command appears in history, look for `transparency:repaired` and `createV2Client:fetch in-process` in `debug.log`.

## For Plugin Developers

### Repository Layout

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Exports public APIs and creates the server plugin. |
| `src/plugin.ts` | Registers OpenCode hooks, tools, events, and lifecycle handling. |
| `src/controller.ts` | Manages sandbox state and lifecycle. |
| `src/adapter.ts` | Converts policy into SRT configuration and wraps commands. |
| `src/permission-bridge.ts` | Bridges SRT network asks to human TUI decisions. |
| `src/transparency.ts` | Restores original commands in parts and model history. |
| `src/redactor.ts` | Applies configurable regular-expression redaction. |
| `src/policy-store.ts` | Loads and merges global/project policy. |
| `src/runtime-store.ts` | Persists server state and pending asks for the TUI. |
| `src/tui/` | TUI toggle, approval dialog, and status display. |
| `test/` | Unit, protocol, policy, transparency, and integration tests. |

### Execution Pipeline

The key invariant is: **execute the wrapped command, store and display the original command**.

1. OpenCode receives an LLM `bash` call with the original command.
2. `tool.execute.before` stores the original command by `callID` and replaces `args.command` with the SRT-wrapped command.
3. OpenCode executes the same `args` object, so the actual child process crosses the OS sandbox boundary.
4. `tool.execute.after` restores the title and in-memory arguments and schedules a part repair.
5. `TransparencyRepair` updates `part.state.input.command` in the server store.
6. `experimental.chat.messages.transform` sanitizes existing history before model conversion and mutates the message array in place.

The in-place mutation is intentional: the current OpenCode integration invokes the transform hook but continues using its original message array instead of consuming a replacement return value.

### OpenCode Hooks

The server plugin currently uses:

- `tool.execute.before`: sandbox `bash` commands before the real spawn.
- `tool.execute.after`: restore titles, redact output, and repair stored parts.
- `experimental.chat.messages.transform`: prevent wrapped commands from entering the next model request.
- `event`: receive human-only TUI commands and reply to OpenCode permission requests for wrapped calls.
- `dispose`: release sandbox resources.

The plugin deliberately does not replace OpenCode's native `bash` implementation. This preserves native timeout, abort, output, permission, and process handling.

### Transparency Details

OpenCode's native bash implementation may call metadata while the command is running. At that point the shared `args` object contains the wrapped command, so a short-lived intermediate part can contain `bwrap`.

The plugin repairs this without changing OpenCode core:

- Keep `callID -> original command` in memory.
- Track `sessionID` and, when available, `messageID` for targeted lookup.
- Repair the completed tool part through the v2 SDK.
- On the next model transform, decode `SRT_ENCODED_CMD` from the wrapper if the process restarted and the in-memory mapping is gone.
- Use `[sandboxed command]` if recovery is impossible; never forward the full wrapper to the model.

The v2 SDK client uses OpenCode's in-process fetch when available. This is required for compiled deployments where `serverUrl` may point to an unavailable localhost port.

### Network and TUI Protocol

The server writes state and pending asks to:

```text
~/.config/opencode-sandbox/runtime.json
```

The TUI polls this file, displays approval dialogs, and sends decisions through `tui.command.execute`. This is a human-only channel and is intentionally not exposed as an LLM tool.

The runtime file is the authoritative server-to-TUI channel in compiled deployments. SSE event delivery is best-effort because the event direction may not reach the TUI plugin.

### Redaction API

The public API exports `Redactor`, `RedactionPattern`, and `SandboxPolicy`:

```ts
import { Redactor } from "@yuxuanyu/opencode_sandbox_plugin"

const redactor = new Redactor([
  {
    name: "private_key",
    pattern: "-----BEGIN [A-Z ]+ PRIVATE KEY-----[\\s\\S]+?-----END [A-Z ]+ PRIVATE KEY-----",
    replacement: "[PRIVATE KEY REDACTED]",
  },
])

const result = redactor.apply(output)
// result.output, result.maskedCount
```

Keep patterns specific enough to avoid masking ordinary output. Invalid patterns should be treated as configuration errors by callers before enabling redaction.

### Development

```bash
bun install
npm run typecheck
bun test
bun run build:tui
RUN_SRT=1 bun test test/integration.test.ts
```

The regular test suite mocks SRT. `RUN_SRT=1` enables tests that require a real OS sandbox and its host dependencies.

### Local Tarball Publishing

This section is for plugin developers and maintainers. It is not required for users installing from npm.

Build the TUI bundle and create a tarball:

```bash
bun run build:tui
npm pack
```

For a local OpenCode distribution, install the tarball into that distribution's plugin cache:

```bash
CACHE_DIR="$HOME/.cache/opencode/packages/@yuxuanyu/opencode_sandbox_plugin@latest"
rm -rf "$CACHE_DIR"
mkdir -p "$CACHE_DIR"
cd "$CACHE_DIR"
npm install /path/to/yuxuanyu-opencode_sandbox_plugin-<version>.tgz
npm ls @yuxuanyu/opencode_sandbox_plugin
```

The exact cache root is distribution-specific. For workspace-cli it is typically:

```text
~/.local/share/workspace-code-prd/cache/workspace-cli/packages/@yuxuanyu/opencode_sandbox_plugin@latest/
```

When publishing to npm, keep the scoped package name stable and ensure both `README.md` and `README_zh.md` are included in the package files list.

### Extension Guidelines

- Keep sandbox enable/disable and network decisions human-only.
- Preserve fail-closed behavior for initialization and dependency failures.
- Do not expose SRT wrapper details to the LLM.
- Add policy fields through `SandboxPolicy`, `config.example.json`, and policy-store defaults together.
- Add tests for policy merging, controller transitions, TUI protocol, redaction, and transparency changes.
- Avoid replacing the native `bash` tool unless OpenCode exposes a stable execution override API.
