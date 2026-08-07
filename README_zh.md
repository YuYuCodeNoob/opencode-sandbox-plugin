# OpenCode 沙箱插件

`@yuxuanyu/opencode_sandbox_plugin` 使用 [Anthropic Sandbox Runtime](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime)，把 OpenCode 的 `bash` 工具命令放入真实的操作系统级沙箱中执行。

- Linux：Bubblewrap（`bwrap`）和 seccomp
- macOS：Seatbelt
- Windows：不支持

插件由两部分组成：负责执行隔离的 server 插件，以及提供人工控制界面的 TUI 插件。

## 用户指南

### 功能

- 启用后，把每条 OpenCode `bash` 命令放入 OS 级沙箱。
- 通过允许列表、拒绝列表或交互式审批限制网络访问。
- 限制文件系统读写。
- 在 TUI 中显示网络访问审批弹窗。
- 在 TUI 中切换当前进程的沙箱状态。
- 对 `read`、`grep`、`bash` 输出中的常见 API key、token 和密码进行脱敏。
- 不把生成的 `bwrap` 命令写入工具 part、TUI 展示或 LLM 历史。
- Fail-closed：沙箱启用但初始化失败时阻止 `bash`，不会静默退回无沙箱执行。
- 只向 LLM 暴露只读的 `sandbox_status`，沙箱控制始终由人操作。

### 从 npm 安装

将 server 插件加入 `opencode.jsonc`：

```jsonc
{
  "plugin": ["@yuxuanyu/opencode_sandbox_plugin"]
}
```

将 TUI 插件加入 `~/.config/opencode/tui.jsonc`：

```jsonc
{
  "plugin": ["@yuxuanyu/opencode_sandbox_plugin"]
}
```

server 插件和 TUI 插件必须运行在同一台机器上，因为它们通过本地 runtime 文件通信。修改配置后请重启 OpenCode。

### 配置

策略按以下层级合并，后者优先级更高：

| 层级 | 位置 |
| --- | --- |
| 默认值 | 插件内置 |
| 全局配置 | `~/.config/opencode-sandbox/config.json` |
| 项目配置 | `<project>/.opencode-sandbox.json` |
| 运行时覆盖 | 内存中，由 TUI 开关控制 |

对象会深度合并，数组由高优先级配置整体替换。

配置示例：

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

网络策略：

- `allowedDomains`：无需弹窗即可访问的域名。
- `deniedDomains`：始终拒绝的域名，优先级高于允许列表。
- `strictAllowlist: true`：未列出的域名直接拒绝，不弹窗。
- `strictAllowlist: false`：未列出的域名弹出人工审批。
- 15 秒内没有选择时自动拒绝。
- “始终允许”会把域名写入全局允许列表。

文件系统策略：

- `denyRead`：禁止读取指定路径。
- `allowRead`：允许读取指定路径。
- `allowWrite`：限制可写路径。
- `denyWrite`：优先于 `allowWrite`。
- OpenCode 工作目录和 SRT 临时路径属于运行所需路径。

脱敏策略：

- 默认关闭。
- `pattern` 是字符串形式的 JavaScript 正则表达式。
- 可以通过 `replacement` 自定义替换文本，否则使用默认掩码。
- 脱敏作用于工具输出，不改变实际执行的命令。

### 使用方式

TUI 左下角提供 `Sandbox` 入口，可以查看当前状态并切换当前进程的沙箱。宿主 TUI 支持时，也可以使用 `/sandbox-toggle`。

访问未列出的域名时会弹窗：

- **仅允许一次**：只允许当前请求。
- **始终允许**：允许当前请求，并将域名持久化到全局允许列表。
- **拒绝**：拒绝当前请求。

只读工具 `sandbox_status` 会报告当前状态、有效策略来源、活动子进程、待处理网络授权和最近的违规记录。

### 状态与 Fail-closed

| 状态 | 行为 |
| --- | --- |
| `disabled` | `bash` 不使用本插件的沙箱。 |
| `initializing` | 初始化完成前阻止 `bash`。 |
| `active` | `bash` 在 OS 沙箱中执行。 |
| `pending-refresh` | 已存在的进程继续使用当前策略，等待刷新。 |
| `error` | 阻止 `bash`，直到用户关闭或重新启用成功。 |

当平台、SRT 依赖或运行时初始化不可用时，插件不会退回无沙箱执行。

### 系统要求与限制

- Linux 需要 SRT 运行时依赖，通常包括 `bwrap`、`socat` 和必要时的 `ripgrep`。
- macOS 使用 Seatbelt。
- Windows 不支持。
- 只有 `bash` 工具受保护；`read`、`edit`、MCP 工具及独立创建的进程不在此边界内。
- 实际子进程中必然存在包装命令，但插件会在持久化历史和 LLM 上下文中恢复原始命令。
- 宽泛的网络允许列表仍可能允许向该域名上传数据。
- 未安装 TUI 插件时，待处理网络请求会在超时后自动拒绝。
- server 和 TUI 插件必须运行在同一台机器上。

### 用户排障

排查本地安装时检查：

```text
~/.config/opencode-sandbox/config.json
~/.config/opencode-sandbox/runtime.json
~/.config/opencode-sandbox/debug.log
```

常见检查项：

- 确认 server 和 TUI 插件配置都已添加。
- 修改配置后重启 OpenCode。
- 如果状态为 `error`，通过 `sandbox_status` 查看 `lastError`，并确认 SRT 依赖已安装。
- 如果审批弹窗不出现，检查 `runtime.json` 中是否有待处理 ask，并确认 TUI 插件已加载。
- 如果历史中出现包装命令，在 `debug.log` 中查找 `transparency:repaired` 和 `createV2Client:fetch in-process`。

## 插件开发者指南

### 目录结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 导出公共 API 并创建 server 插件。 |
| `src/plugin.ts` | 注册 OpenCode hooks、工具、事件和生命周期处理。 |
| `src/controller.ts` | 管理沙箱状态和生命周期。 |
| `src/adapter.ts` | 将策略转换为 SRT 配置并包装命令。 |
| `src/permission-bridge.ts` | 将 SRT 网络请求桥接到人工 TUI 决策。 |
| `src/transparency.ts` | 在 part 和模型历史中恢复原始命令。 |
| `src/redactor.ts` | 执行可配置的正则脱敏。 |
| `src/policy-store.ts` | 加载并合并全局/项目策略。 |
| `src/runtime-store.ts` | 为 TUI 持久化 server 状态和待处理请求。 |
| `src/tui/` | TUI 开关、审批弹窗和状态展示。 |
| `test/` | 单元、协议、策略、透明修复和集成测试。 |

### 执行流水线

核心不变量是：**执行使用包装命令，存储和展示使用原始命令**。

1. OpenCode 收到带有原始命令的 LLM `bash` 调用。
2. `tool.execute.before` 按 `callID` 保存原始命令，并把 `args.command` 替换为 SRT 包装命令。
3. OpenCode 使用同一个 `args` 对象执行，因此真实子进程跨过 OS 沙箱边界。
4. `tool.execute.after` 恢复标题和内存中的参数，并安排 part 修复。
5. `TransparencyRepair` 通过 v2 SDK 更新 server store 中的 `part.state.input.command`。
6. `experimental.chat.messages.transform` 在模型转换前清洗历史，并原地修改消息数组。

原地修改是必要的：当前 OpenCode 集成会调用 transform hook，但继续使用原始消息数组，不会消费替换后的返回值。

### OpenCode Hooks

当前使用的 hooks：

- `tool.execute.before`：在真实 spawn 前包装 `bash` 命令。
- `tool.execute.after`：恢复标题、脱敏输出并修复持久化 part。
- `experimental.chat.messages.transform`：防止包装命令进入下一次模型请求。
- `event`：接收人工 TUI 命令，并回复包装调用对应的 OpenCode 权限请求。
- `dispose`：释放沙箱资源。

插件不会复制或替换 OpenCode 原生 `bash` 实现，以保留原生的 timeout、abort、输出、权限和进程处理逻辑。

### 透明抽象细节

OpenCode 原生 bash 实现可能在命令运行期间调用 metadata。此时共享的 `args` 对象已经包含包装命令，所以中间状态的 tool part 可能短暂出现 `bwrap`。

插件在不修改 OpenCode 核心代码的前提下修复它：

- 在内存中保存 `callID -> original command`。
- 跟踪 `sessionID`，并在可用时跟踪 `messageID` 以定向查询。
- 通过 v2 SDK 修复已完成的 tool part。
- 如果进程重启导致内存映射丢失，在下一次 model transform 中从包装命令的 `SRT_ENCODED_CMD` 解码原始命令。
- 无法恢复时使用 `[sandboxed command]`，绝不把完整包装命令发送给模型。

v2 SDK client 会在可用时使用 OpenCode 的进程内 fetch。编译版部署中 `serverUrl` 可能指向不可用的 localhost 端口，因此这一步是必要的。

### 网络与 TUI 协议

server 将状态和待处理请求写入：

```text
~/.config/opencode-sandbox/runtime.json
```

TUI 轮询该文件并显示审批弹窗，然后通过 `tui.command.execute` 发送决策。这是人工控制通道，不会作为 LLM 工具暴露。

在编译版部署中，runtime 文件是 server 到 TUI 的权威通道；SSE 事件仅作为尽力而为的补充，因为事件方向可能无法到达 TUI 插件。

### 脱敏 API

公共 API 导出 `Redactor`、`RedactionPattern` 和 `SandboxPolicy`：

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

正则应尽量具体，避免误伤普通输出。启用脱敏前，调用方应将无效 pattern 视为配置错误处理。

### 开发与测试

```bash
bun install
npm run typecheck
bun test
bun run build:tui
RUN_SRT=1 bun test test/integration.test.ts
```

常规测试使用 mock SRT；`RUN_SRT=1` 会启用需要真实 OS 沙箱和宿主依赖的集成测试。

### 本地 Tarball 发布

本节只面向插件开发者和维护者，普通用户从 npm 安装时不需要执行这些步骤。

构建 TUI bundle 并生成 tarball：

```bash
bun run build:tui
npm pack
```

对于本地 OpenCode 发行版，把 tarball 安装到对应发行版的插件缓存目录：

```bash
CACHE_DIR="$HOME/.cache/opencode/packages/@yuxuanyu/opencode_sandbox_plugin@latest"
rm -rf "$CACHE_DIR"
mkdir -p "$CACHE_DIR"
cd "$CACHE_DIR"
npm install /path/to/yuxuanyu-opencode_sandbox_plugin-<version>.tgz
npm ls @yuxuanyu/opencode_sandbox_plugin
```

缓存根目录取决于发行版。workspace-cli 通常使用：

```text
~/.local/share/workspace-code-prd/cache/workspace-cli/packages/@yuxuanyu/opencode_sandbox_plugin@latest/
```

发布到 npm 时保持 scoped 包名不变，并确认 `README.md` 与 `README_zh.md` 都在 package files 列表中。

### 扩展原则

- 沙箱开关和网络决策必须保持人工控制。
- 初始化和依赖失败时保持 fail-closed。
- 不要把 SRT 包装细节暴露给 LLM。
- 新增策略字段时同步更新 `SandboxPolicy`、`config.example.json` 和 policy-store 默认值。
- 为策略合并、controller 状态转换、TUI 协议、脱敏和透明修复补充测试。
- 除非 OpenCode 提供稳定的执行覆盖 API，否则不要替换原生 `bash` 工具。
