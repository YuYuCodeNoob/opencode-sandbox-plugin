# opencode-sandbox-plugin

Sandbox OpenCode's `bash` tool commands inside a real OS boundary using
[Anthropic Sandbox Runtime](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime)
(bwrap/seccomp on Linux, Seatbelt on macOS), with transparent abstraction — the
wrapped command prefix never reaches the DB, the TUI, or the LLM context.

> Design source: [CLAUDE.md](./CLAUDE.md) (authoritative PRD/design).

## Features

- **Real sandboxing** of `bash` tool commands (each command spawns inside the sandbox).
- **Network allow-only** with a **human-only TUI approval dialog**
  (Allow once / Always allow / Deny).
- **Filesystem policy** (allow/deny read & write) with violation toasts.
- **TUI bottom-left toggle** (`🛡 ON / ON* / OFF / OFF* / ERROR`) to enable/disable
  the sandbox for the current process. `*` marks a runtime override.
- **Transparent abstraction**: the bwrap wrapper is restored to the original
  command in stored parts and display titles.
- **Fail-closed**: if the sandbox is enabled but cannot initialize, bash is
  blocked rather than silently falling back to unsandboxed execution.

Sandbox **control is not exposed to the LLM** — there are no
enable/disable/allow tools the model can call (they would let it escape the
sandbox). Control lives in the TUI: a clickable status toggle and the network
approval dialog. The only LLM-visible tool is the read-only `sandbox_status`.

## Install

The package ships **two** plugins: a server plugin (sandbox enforcement) and a
TUI plugin (toggle + approval dialog). Install both:

**1. Server plugin** — add to `opencode.jsonc` (`~/.config/opencode/opencode.jsonc`
or the project's `opencode.jsonc`):

```jsonc
{
  "plugin": ["@yuxuanyu/opencode_sandbox_plugin"]
}
```

**2. TUI plugin** — add to `~/.config/opencode/tui.jsonc`:

```jsonc
{
  "plugin": ["@yuxuanyu/opencode_sandbox_plugin"]
}
```

Restart OpenCode. The bottom-left corner shows the sandbox toggle; network
requests to unlisted domains raise a TUI approval dialog.

### Local publish (no registry)

`npm pack`, then install the tarball into opencode's plugin cache so the name
resolves for both the server and TUI loader:

```bash
bun run build:tui   # bundles dist/tui.js for the TUI plugin
npm pack
mkdir -p ~/.cache/opencode/packages/@yuxuanyu/opencode_sandbox_plugin@latest
cd ~/.cache/opencode/packages/@yuxuanyu/opencode_sandbox_plugin@latest
npm install /path/to/yuxuanyu-opencode_sandbox_plugin-0.2.0.tgz
```

(`Npm.add` reuses `node_modules/<name>` when present, so no registry is needed.)

## Configuration

Sandbox policy is read from three layers (highest wins, deep-merged):

| Layer | Location |
|---|---|
| Project | `<project>/.opencode-sandbox.json` |
| Global | `~/.config/opencode-sandbox/config.json` |
| Runtime override | in-memory (per process, via the TUI toggle) |

```jsonc
{
  "enabledByDefault": false,
  "network": {
    "allowedDomains": ["api.example.com"],
    "deniedDomains": [],       // takes precedence over allow; bare "*" = deny-all
    "strictAllowlist": false   // true = never prompt, unlisted domains denied
  },
  "filesystem": {
    "denyRead": ["~/.ssh"],    // deny-then-allow
    "allowRead": [],
    "allowWrite": ["."],       // allow-only; cwd and SRT temp paths are always allowed
    "denyWrite": [".env"],     // overrides allowWrite
    "allowGitConfig": false
  }
}
```

## Usage

- **Sandbox entry** (bottom-left): the static `Sandbox` label. Click it to open
  a dialog showing the **current** sandbox state (read from the runtime file) and
  confirm the toggle; or type `/sandbox-toggle`. The label is intentionally static
  because the TUI's `app_bottom` slot renders once and cannot be re-rendered live
  in compiled OpenCode builds.
- **State feedback**: after a toggle, a toast shows `已启用` / `已关闭`;
  `sandbox_status` (LLM tool) returns the authoritative state.
- **Network approval** (TUI dialog when an unlisted host is requested):
  - **Allow once** — lets the current blocked connection through, nothing is persisted.
  - **Always allow** — allows the current connection and writes the host to the
    global allowlist (future connections won't prompt).
  - **Deny** — rejects the connection.
  - If no choice is made within 15s the connection is denied (fail-closed).
- `sandbox_status` (read-only, LLM-visible) — state, policy source, pending
  network grants, recent violations.

## How it works

1. `tool.execute.before` (bash) rewrites `args.command` to SRT's wrapped
   command — the same `args` reference flows into the real spawn
   (`shell -c <wrapped>`), so the OS boundary is actually enforced.
2. `tool.execute.after` restores the original command in the stored part and in
   the tool's display/LLM title (transparency).
3. When the sandbox is active, the plugin auto-approves OpenCode's own bash
   permission prompt for wrapped commands (the sandbox policy — not OpenCode's
   bash permission — is the security authority).
4. SRT's network `askCallback` writes a pending ask to the shared runtime file
   (`~/.config/opencode-sandbox/runtime.json`). The TUI plugin polls it and
   raises a TUI approval dialog; decisions are sent back over
   `tui.command.execute` (`client.tui.publish`) — a channel the LLM cannot reach.
5. Violations are read from the SRT violation store and shown as toasts.

The server plugin and TUI plugin exchange state over the shared runtime file
(server→TUI) and the `tui.command.execute` event (TUI→server). The server also
publishes the same events best-effort, but in compiled OpenCode builds the SSE
event direction may not reach the TUI plugin, so the runtime file is the
authoritative server→TUI channel.

## Fail-closed

- `disabled` → bash runs unsandboxed.
- `active` → bash runs sandboxed.
- `initializing` / `error` (including unsupported platform) → bash throws;
  you must explicitly disable the sandbox (TUI toggle) to run unsandboxed again.

## Requirements

- Linux (bwrap, socat, ripgrep) or macOS (Seatbelt). Windows is **unsupported**
  (plugin cannot reach the structured-argv spawn seam needed on Windows).
- OpenCode server with an HTTP URL reachable by the plugin (for the v2 SDK
  client used to update parts and reply to permissions).

## Limitations (v1)

- Only the `bash` tool is sandboxed. `read`/`edit` and MCP-spawned processes
  are not covered.
- The wrapper prefix is unavoidably present in the actual child process; it is
  restored everywhere it would otherwise leak (DB, display, LLM context).
- Allowing a broad domain still permits uploading data to that domain; the
  sandbox restricts, it does not guarantee against every exfiltration path.
- Unix socket / Apple Events / weaker-isolation options are hardcoded off and
  not configurable.
- Without the TUI plugin installed, network approval falls back to a toast and
  auto-denies after the timeout (the server stays fail-closed).
- The TUI's `app_bottom` slot renders a static snapshot: the toggle label reads
  the runtime file on each repaint (it may lag a change by one repaint), and
  the network dialog is raised by polling rather than push events.
- Server→TUI communication relies on the shared runtime file, so server and TUI
  must run on the same machine (the standard local OpenCode deployment).

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit tests (mocked SRT)
RUN_SRT=1 bun test test/integration.test.ts   # real bwrap sandbox tests
bun run build:tui   # bundle dist/tui.js (TUI plugin)
```
