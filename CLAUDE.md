# OpenCode Sandbox Plugin — PRD / 设计文档

> 本文档是本项目的权威设计来源（PRD + 技术设计）。实现时应以本文件为准；`opencode_plugin设计对话记录.md` 是设计过程留档，仅作背景参考。

**状态**：设计已确认，进入实现阶段
**日期**：2026-08-04
**版本**：v1

---

## 1. 项目概述

用 **OpenCode plugin** 形式向 OpenCode 注入进程级沙箱，执行后端使用 Anthropic 提供的
`@anthropic-ai/sandbox-runtime`（SRT）v0.0.66（源码参考 `~/plugin/sandbox-runtime`）。

### 核心价值

- bash tool 的每个命令在**真实 OS 边界**（Linux bwrap/seccomp、macOS Seatbelt）内执行
- 未配置的网络 / 文件访问时，TUI 弹出 **allow/deny 选择**（"Event Toast 选择"）
- 沙箱策略（网络 allowlist、文件系统读写范围）持久化、可覆盖
- **透明抽象**：包装前缀绝不落入 DB / 展示 / LLM 上下文（防 token 爆炸）

### v1 范围（用户确认）

- ✅ bash tool 真实沙箱化（核心）
- ✅ 网络授权（allow-only + 弹窗）
- ✅ 文件策略 + 违规记录
- ✅ TUI 交互：未配置访问弹窗选择、状态自定义 tool、通知 toast

### v1 明确不覆盖

- MCP 进程（由 MCP server 内部 spawn，纯插件够不到 spawn seam）
- `read` / `edit` 等不经 spawn 的工具
- TLS MITM、凭据 masking、SigV4 重签名
- 多 session 策略隔离
- Windows 平台（`wrapWithSandboxArgv` 需要结构化 argv，纯插件无法到达）
- Web/Desktop 设置页（收窄为 TUI 自定义 tool + toast）

---

## 2. 架构分层

OpenCode 进程内，插件由 server 进程加载运行：

```
OpenCode server 进程内
├─ SandboxPlugin（入口）
│    注册 hooks、自定义 tools、生命周期，创建以下模块
├─ SandboxController
│    状态机（disabled/initializing/active/pending-refresh/error）
│    单进程策略、子进程计数、fail-closed、pending-refresh
│    所有 SRT 生命周期 API 的唯一调用入口
├─ SandboxRuntimeAdapter
│    产品配置 → SRT config（硬编码安全默认 + getDefaultWritePaths）
│    wrapWithSandbox / updateConfig / reset 唯一调用者
│    平台分支（Linux/macOS 支持，Windows unsupported）
├─ PermissionBridge
│    SRT askCallback ↔ client.permission.create + permission.v2.replied 事件
│    同 host 并发去重
├─ ViolationReporter
│    SRT SandboxViolationStore → session 关联 → toast / 自定义 tool
├─ TransparencyRepair
│    tool.execute.after 恢复 part.state.input 为原始命令
└─ SandboxPolicyStore
    三层配置读取 + deep merge + 持久化
```

**TUI 进程内**（同一 npm 包 `./tui` 导出，经 `~/.config/opencode/tui.jsonc` 加载；参考 `opencode-visual-cache`）：
```
└─ SandboxWidget
     ├─ app_bottom slot：左下角开关（ON/ON*/OFF/OFF*/ERROR，点击 / /sandbox-toggle）
     ├─ 网络授权弹窗（Allow once / Always allow / Deny，api.ui.dialog + DialogSelect）
     └─ api.event.on("tui.command.execute") ↔ client.tui.publish 与服务端通信
```

**职责边界**：
- TUI/agent 只通过自定义 tool + client SDK 与沙箱交互，绝不直接调 `SandboxManager`
- `SandboxController` 是唯一允许调用 SRT 生命周期 API 的对象
- 各模块可独立单测，边界可回答"做什么 / 怎么用 / 依赖什么"

---

## 3. 关键决策记录（已拍板）

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 注入方式 | **纯插件级**：`tool.execute.before` 改写 `args.command`（不改 opencode 内核） |
| D2 | SRT 依赖 | npm 包 `@anthropic-ai/sandbox-runtime@0.0.66`（Bun 下已验证可导入、`isSupportedPlatform()=true`） |
| D3 | 交付形态 | **可发布 npm 包**，独立仓库，通过 opencode.json `plugin` 字段加载 |
| D4 | 配置持久化 | 插件独立配置文件（全局 `~/.config/opencode-sandbox/config.json` + 项目 `.opencode-sandbox.json` + 内存 runtimeOverride），不用 opencode config 写入接口 |
| D5 | 默认网络策略 | **allow-only + 未批准弹窗**（`strictAllowlist=false`） |
| D6 | 透明抽象 | 执行用包装命令，DB/展示/LLM 上下文只含原始命令（`TransparencyRepair` 修复 part） |
| D7 | opencode 权限 | **沙箱开启时接管 bash 权限**：`permission.ask` hook 识别自己的包装命令并自动 allow |
| D8 | 控制权 | **沙箱控制不暴露给 LLM**（enable/disable/allow/deny 工具全部移除，否则 LLM 可逃逸）。控制走 TUI 插件：左下角开关（`app_bottom` slot）+ 网络授权弹窗，经 `tui.command.execute` 事件（`client.tui.publish`）与服务端双向通信 |

---

## 4. 技术事实（已源码验证，实现时以此为准）

### 4.1 OpenCode plugin API（`@opencode-ai/plugin` v1.17）

- 插件函数 `async (input) => Hooks`；`input` 含 `client, project, directory, worktree, experimental_workspace, serverUrl, $`
- 相关 hooks（`src/index.ts` Hooks 接口）：
  - `tool.execute.before`（`input:{tool,sessionID,callID}`，`output:{args}`）——**改写 args 与真实执行共用同一引用**
  - `tool.execute.after`（`input:{tool,sessionID,callID,args}`，`output:{title,output,metadata}`）
  - `permission.ask`（`input: Permission`，`output:{status}`）
  - `shell.env`（仅能改 env，改不了命令）
  - `event`（订阅 session 事件，含 `permission.v2.replied`）
- 插件在 OpenCode server 进程内（Bun）加载

### 4.2 真实 spawn seam（关键）

`packages/opencode/src/tool/shell.ts`：
```ts
// run() 内
const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))
// cmd() 内
return ChildProcess.make(command, [], { shell, cwd, env, stdin: "ignore", detached })
```
- `shell.env` hook 只 merge env，够不到命令 → 不是沙箱注入点
- `tool.execute.before` 改写 `output.args.command` → **真实流入 spawn**（已验证 tools.ts 用同一 args 引用）
- bash 工具执行顺序：`execute` → `collect()`（tree-sitter 解析）→ `ask()`（权限）→ `run()`（spawn）
- **权限检查在工具内部、用包装后的命令** → 必须用 D7 接管

### 4.3 SRT API（`src/index.ts` 导出）

```ts
SandboxManager.initialize(config, sandboxAskCallback?, enableLogMonitor?)
SandboxManager.wrapWithSandbox(command, binShell?, customConfig?, abortSignal?) // Linux/macOS → string
SandboxManager.wrapWithSandboxArgv(command, binShell?, customConfig?, abortSignal?, cwd?) // Windows → {argv, env}
SandboxManager.updateConfig(newConfig)  // 网络即时生效；文件系统需 reset+reinit
SandboxManager.reset()
SandboxManager.isSupportedPlatform()
SandboxManager.checkDependencies(ripgrepConfig?)
SandboxManager.getSandboxViolationStore()  // 进程内，max 100 条
```
- `SandboxAskCallback = (params: {host: string; port: number|undefined}) => Promise<boolean>`
- Linux 上 `wrapWithSandbox("echo hello")` 返回 ~1663 字符 bwrap 前缀（**必须透明抽象**）
- 状态是模块级进程状态 → 每 OpenCode 进程一个 controller

### 4.4 交互机制（SDK client）

- **plugin 自建 v2 client**（`@opencode-ai/sdk/v2`）：`input.client` 是 legacy client，缺 permission/part API。用 `baseUrl=input.serverUrl` + Basic auth（`OPENCODE_SERVER_PASSWORD/USERNAME`）构造。
- `v2.permission.create` 端点（`POST /api/session/{sessionID}/permission`）确实实现（protocol `makePermissionGroup`），但 **TUI 只渲染 v1 `permission.asked` 事件**（`tui/src/context/sync.tsx:190`），v2-created 请求不显示 → 网络授权不走此路径（见 §7 变体）
- v1 回复端点 `client.permission.reply({requestID, reply})`（`POST /permission/{requestID}/reply`）→ 解析 bash 工具进程内创建的 v1 请求（D7 用）
- `client.part.update({sessionID, messageID, partID, part})`（顶层 `part` 命名空间）→ 透明修复
- `client.tui.showToast({title, message, variant, duration})` → toast

---

## 5. 配置模型

### 5.1 三层配置

| 层 | 位置 | 内容 | 优先级 |
|---|---|---|---|
| 项目覆盖 | `<project>/.opencode-sandbox.json` | 项目级策略 | 高 |
| 全局默认 | `~/.config/opencode-sandbox/config.json` | 用户级策略 + 开关 | 中 |
| 运行时覆盖 | 插件内存 | 本进程 enable/disable + 授权累积 | 最高 |

**合并规则**：运行时覆盖 > 项目覆盖 > 全局默认；未写字段向下层继承（deep merge）。

### 5.2 产品策略 schema

```ts
type SandboxPolicy = {
  enabledByDefault: boolean
  network: {
    allowedDomains: string[]   // allow-only，空 = 零网络
    deniedDomains: string[]    // 优先于 allow，支持裸 "*"（deny-all）
    strictAllowlist: boolean   // true 时未批准域名直接拒绝、不弹窗
  }
  filesystem: {
    denyRead: string[]         // deny-then-allow，默认 ["~/.ssh"]
    allowRead: string[]        // 覆盖 denyRead
    allowWrite: string[]       // allow-only，默认 [cwd]，空 = 无写
    denyWrite: string[]        // 覆盖 allowWrite
    allowGitConfig: boolean    // 允许写 .git/config
  }
}
```

### 5.3 内部 SRT 配置分层

- Adapter 负责把产品配置翻译成完整 `SandboxRuntimeConfig`，**必须通过 `SandboxRuntimeConfigSchema` 校验**
- **固定安全默认（硬编码，不可被产品配置覆盖）**：
  - `allowAllUnixSockets=false`、`enableWeakerNestedSandbox=false`、`enableWeakerNetworkIsolation=false`、`allowAppleEvents=false`
  - `filesystem.disabled=false`
  - 临时目录合并 `getDefaultWritePaths()`
- 有效开关 = `runtimeOverride ?? enabledByDefault`；disable 不清除持久配置，re-enable 走完整初始化

---

## 6. bash 沙箱化执行流程（核心）

### 6.1 执行包装 + 透明抽象

```
tool.execute.before({tool:"bash"}, output)
  ├─ controller.isEnabled()? 否 → 不处理（原始执行）
  ├─ controller.isActive()? 否 → throw（fail-closed）
  ├─ TransparencyRepair 记录 callID → 原始 command
  ├─ output.args.command = adapter.wrapWithSandbox(原始command, {cwd})
  └─ 返回

spawner.spawn → shell -c <bwrap 包装命令>    // 真实沙箱边界生效

tool.execute.after({callID,...})
  └─ TransparencyRepair：定位 part → client.part.update
       恢复 part.state.input.command = 原始命令 + output.title 修正
     （completeToolCall 保留 fresh part 的 input，修复可持久）
```

### 6.2 平台分支

- **Linux（bwrap）**：`wrapWithSandbox(command)` 返回字符串，shell -c 执行 ✓
- **macOS（Seatbelt）**：同上 ✓
- **Windows**：需要 `wrapWithSandboxArgv` 结构化 argv，纯插件无法到达 → **状态 error + `sandbox_platform_unsupported`**，绝不发布半沙箱

### 6.3 权限接管（D7，实现变体）

**已源码验证：当前 opencode 从未触发 `permission.ask` hook**（全仓仅类型声明，`packages/opencode/src/plugin` 的 `trigger` 无此调用点）。因此改用 `event` hook + v1 reply：

- `event` hook 监听 `permission.asked`（bash 工具 `ctx.ask` 创建 v1 请求时发布）
- 若 `properties.tool.callID` 是本插件包装过的（`TransparencyRepair` 注册表），调用 `client.permission.reply({requestID, reply:"once"})`（v1 端点 `/permission/{requestID}/reply`）自动放行
- 原因：沙箱策略是安全权威，opencode bash 权限被沙箱取代；沙箱关闭时不接管

### 6.4 已知取舍

- 包装前缀在**实际子进程**中不可避免（固有，已通过透明修复隔离）
- 自定义 tool 展示原始命令；包装命令不进 DB（`tool.execute.after` 用 `client.part.update` 恢复 `state.input.command` + 修正 `output.title`）
- 只覆盖 bash tool；每次 bash 执行是独立 spawn，符合文件策略"下次生效"

---

## 7. 网络授权桥（PermissionBridge，实现变体）

**已源码验证：`v2.permission.create` 端点存在但 TUI 只渲染 v1 `permission.asked`（`tui/src/context/sync.tsx:190`），v2-created 请求不会显示弹窗**；v1 权限系统又没有 HTTP create 端点。故改为 **TUI 弹窗授权**（D8：控制权在 TUI 人机，不暴露给 LLM）：

```
askCallback({host, port})
  → 按 host 去重（同 host 并发共享一个 pending Promise，生成 ask id）
  → 写入共享 runtime 文件（~/.config/opencode-sandbox/runtime.json 的 asks[]）
  → 挂起该连接（SRT 逐连接阻塞等待回调，已源码验证 filterNetworkRequest）
     ├─ Allow once     → resolve(true)  当前连接放行，不写 allowlist
     ├─ Always allow   → resolve(true) + controller.allowNetwork() → 持久化 + updateConfig 即时生效
     ├─ Deny           → resolve(false) 当前连接拒绝
     └─ 超时(默认 15s)  → resolve(false) + 从 asks[] 移除
```
- **通信通道（实测修正）**：TUI→server 用 `client.tui.publish({type:"tui.command.execute",properties:{command:<json>}})`（已验证可达）；
  **server→TUI 不走 SSE 事件** —— 编译版 opencode（1.17.20）中服务端发布的 `tui.command.execute` 因 `event.location.directory` 与 TUI instance 不匹配而到不了 TUI 的 `api.event.on`（已实测），
  改用**共享 runtime 文件**：服务端每次状态/ask 变化写 `runtime.json`，TUI 插件轮询。
- **TUI 渲染限制（实测）**：`app_bottom` slot 是**静态快照**，SolidJS 信号/effect 不触发重渲染；
  开关在每次 TUI 重绘时同步读文件；授权弹窗用 `setInterval` 轮询 + `api.ui.dialog.replace` 命令式弹出（已验证可行）。
- `strictAllowlist=true` → 不询问直接拒绝
- 不承诺切断已建立连接（由 SRT 实现决定）

---

## 8. 文件策略 + 违规记录

- 违规（被 SRT 拦截的路径读/写）→ `SandboxViolationStore`（进程内 100 条）→ ViolationReporter 关联 session → toast + 自定义 tool 展示
- **文件授权**：违规时走 PermissionBridge（`action:"sandbox.filesystem"`）；批准后进入 **pending-refresh**
  - 文件策略变更需 `reset()+initialize()` 才生效
  - 有活动子进程 → 等最后子进程退出后在安全边界 reset+reinit
  - **授权后下一次 bash 执行生效，绝不伪称热更新**；当前执行不重试
- 授权消息明确标注"从下一次执行开始生效"

---

## 9. TUI 交互层

| 需求 | 实现 |
|---|---|
| 未配置访问选择 | PermissionBridge → runtime 文件 `asks[]` → TUI 轮询 → `api.ui.dialog.replace` 命令式弹窗（Allow once / Always allow / Deny） |
| 状态查看 | 只读自定义 tool `sandbox_status`（状态/来源/违规摘要，LLM 可见但无逃逸面） |
| 开关控制 | TUI 插件 `app_bottom` slot 左下角静态入口 `Sandbox`，点击弹「当前状态 + 确认切换」对话框（dialog 可靠渲染），或 `/sandbox-toggle` |
| 状态同步 | 服务端写 `runtime.json`；**静态 slot 无法实时刷新**（实测：信号/toast/dialog 均不触发 `app_bottom` 重渲染），状态在点击弹窗 / toast 中展示 |
| 通知 | `client.tui.showToast()`：状态变更、文件违规（server→TUI 受限时可能不显示，弹窗是主通道） |

**通信**：
- TUI→server：`client.tui.publish({ body: { type: "tui.command.execute", properties: { command: <JSON> } } })`
  —— `sandbox.get / sandbox.toggle / sandbox.allow / sandbox.deny`，服务端 `event` hook 处理（已验证可达）。
- server→TUI：共享文件 `~/.config/opencode-sandbox/runtime.json`（`src/runtime-store.ts`），
  服务端写、TUI 轮询读。协议类型在 `src/tui-protocol.ts` + `src/runtime-store.ts`。

---

## 10. 生命周期 / 状态机 / fail-closed

```
disabled ──enable──▶ initializing ──成功──▶ active
                      │ 失败               │ 文件策略变更 + 活动子进程
                      ▼                    ▼
                    error            pending-refresh ──reset+reinit──▶ active
```
- 有效开关 = `runtimeOverride ?? enabledByDefault`
- **fail-closed**：`initializing`/`error` 状态 bash 直接 throw，绝不回退未沙箱执行；必须显式 disable
- 平台不支持 → `error` + `lastError.code=sandbox_platform_unsupported`
- initialize/reset/updateConfig **串行化**；异常路径清理 pending 请求与订阅

---

## 11. 安全模型与限制

- 固定安全默认见 §5.3
- **不记录**命令中的 token、代理认证 token、凭据真实值、完整环境变量
- 日志/错误只含去敏摘要
- 文档需向用户说明 SRT 限制：宽域名放行仍可能上传数据；Linux mandatory deny 对新建路径存在实现限制；Unix socket 放行 ≈ 宿主机访问

---

## 12. 测试与验收矩阵

| 场景 | 通过条件 |
|---|---|
| 真实沙箱 | `bash -c 'touch <越权路径>'` 失败；未批准域名 curl 失败 |
| 透明抽象 | 执行后 part.state.input 为原始命令，无 bwrap 前缀 |
| 权限接管 | 包装命令被 `permission.ask` hook 自动 allow，不弹框 |
| 授权桥 | 未配置域名 → 一次弹窗 → allow 后同域名连接成功 |
| 并发去重 | 同 host 并发只弹一次窗 |
| fail-closed | 初始化失败时 bash 抛错，无降级 |
| 文件授权 | 授权路径下一次执行可写，当前执行不变 |

验证层次：先跑失败测试证明 seam/状态错误 → 最小实现转绿 → 真实 spawn + 平台依赖检查 + 类型检查 + 回归。

---

## 13. 实现顺序（v1）

1. **工程骨架**：npm 包（Bun + TS）、plugin 入口、配置读取
2. **SandboxRuntimeAdapter**：产品配置 → SRT config、wrap 调用、平台检测（先写死 Linux 验证）✅
3. **SandboxController**：状态机、串行生命周期、fail-closed、子进程计数 ✅
4. **bash 包装 + TransparencyRepair**：`tool.execute.before/after` + part 修复 + 权限接管（D7 变体见 §6.3）✅
5. **PermissionBridge**：askCallback ↔ 等待式半交互 + `sandbox_allow/deny` 工具（变体见 §7）✅
6. **文件违规 + pending-refresh** ✅
7. **自定义 tools + toast + 配置持久化**（status/enable/disable/allow/deny）✅
8. **验收矩阵测试**（§12；真实 SRT 集成测试 `RUN_SRT=1` 已验证 bwrap 拦截越权写）✅
9. **控制权迁移（D8）**：移除 enable/disable/allow/deny 四个 LLM 工具；新增 TUI 插件（`./tui` 导出 + `build.tui.mjs`），左下角开关 + 网络授权弹窗，经 `tui.command.execute` 事件通信（✅ 2026-08-05）

## 14. 参考资料

- 设计过程留档：`opencode_plugin设计对话记录.md`
- SRT 源码：`~/plugin/sandbox-runtime`（`src/index.ts`、`src/sandbox/sandbox-manager.ts`、`sandbox-config.ts`、`sandbox-schemas.ts`）
- OpenCode plugin API：`~/coding_agent/opencode/packages/plugin/src/index.ts`（Hooks 接口）
- OpenCode shell 实现：`~/coding_agent/opencode/packages/opencode/src/tool/shell.ts`、`src/session/tools.ts`、`src/session/processor.ts`、`src/permission/index.ts`
