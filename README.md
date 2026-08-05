# opencode-sandbox-plugin

Sandbox OpenCode's `bash` tool commands inside a real OS boundary using
[Anthropic Sandbox Runtime](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime)
(bwrap/seccomp on Linux, Seatbelt on macOS), with transparent abstraction — the
wrapped command prefix never reaches the DB, the TUI, or the LLM context.

> Design source: [CLAUDE.md](./CLAUDE.md) (authoritative PRD/design).

## Features

- **Real sandboxing** of `bash` tool commands (each command spawns inside the sandbox).
- **Network allow-only** with a waiting semi-interactive approval flow.
- **Filesystem policy** (allow/deny read & write) with violation toasts.
- **Transparent abstraction**: the bwrap wrapper is restored to the original
  command in stored parts and display titles.
- **Fail-closed**: if the sandbox is enabled but cannot initialize, bash is
  blocked rather than silently falling back to unsandboxed execution.
- **Custom tools**: `sandbox_status`, `sandbox_enable`, `sandbox_disable`,
  `sandbox_allow`, `sandbox_deny`.

## Install

Add the package to the `plugin` array in `opencode.json`:

```jsonc
{
  "plugin": ["@yuxuanyu/opencode_sandbox_plugin"]
}
```

Local publish (no registry needed): `npm pack`, then install the tarball into
opencode's plugin cache so the name resolves:

```bash
npm pack
mkdir -p ~/.cache/opencode/packages/@yuxuanyu/opencode_sandbox_plugin@latest
cd ~/.cache/opencode/packages/@yuxuanyu/opencode_sandbox_plugin@latest
npm install /path/to/yuxuanyu-opencode_sandbox_plugin-0.1.0.tgz
```

(`Npm.add` reuses `node_modules/<name>` when present, so no registry is needed.)

## Configuration

Sandbox policy is read from three layers (highest wins, deep-merged):

| Layer | Location |
|---|---|
| Project | `<project>/.opencode-sandbox.json` |
| Global | `~/.config/opencode-sandbox/config.json` |
| Runtime override | in-memory (per process, via `sandbox_enable`/`sandbox_disable`) |

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

- `sandbox_enable` — enable for this session (initializes SRT; fail-closed).
- `sandbox_disable` — disable; bash returns to unsandboxed execution.
- `sandbox_allow {host} [{project|global}]` — allow a network domain. If a
  connection to that host is currently pending, it is approved immediately and
  the blocked command continues; the policy also updates live for future
  connections and is persisted.
- `sandbox_deny {host} [{project|global}]` — deny a domain (takes precedence).
- `sandbox_status` — state, policy version, active children, pending grants,
  recent violations.

When an unlisted network host is requested, a toast prompts you to allow it;
the command's connection is paused for up to 15s (configurable), then denied.

## How it works

1. `tool.execute.before` (bash) rewrites `args.command` to SRT's wrapped
   command — the same `args` reference flows into the real spawn
   (`shell -c <wrapped>`), so the OS boundary is actually enforced.
2. `tool.execute.after` restores the original command in the stored part and in
   the tool's display/LLM title (transparency).
3. When the sandbox is active, the plugin auto-approves OpenCode's own bash
   permission prompt for wrapped commands (the sandbox policy — not OpenCode's
   bash permission — is the security authority).
4. SRT's network `askCallback` surfaces as a toast + pending grant, resolved by
   `sandbox_allow`/`sandbox_deny` (waiting semi-interactive; approved requests
   let the current connection proceed).
5. Violations are read from the SRT violation store and shown as toasts.

## Fail-closed

- `disabled` → bash runs unsandboxed.
- `active` → bash runs sandboxed.
- `initializing` / `error` (including unsupported platform) → bash throws;
  you must explicitly disable the sandbox to run unsandboxed again.

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

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit tests (mocked SRT)
RUN_SRT=1 bun test test/integration.test.ts   # real bwrap sandbox tests
```
