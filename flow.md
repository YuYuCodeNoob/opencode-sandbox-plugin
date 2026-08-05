# 数据流源码地图（flow.md）

> 配套文档。每条数据流都标注了**代码在哪里**（`文件:行号`），点击即可跳转。
> 两个代码根：
> - **插件**：`/home/yuyx51/opencode_sandbox_plugin`（下称 `src/…`）
> - **opencode 核心源码**：`/home/yuyx51/coding_agent/opencode/packages`（下称 `opencode/…`；TUI 在 `tui/…`）

---

## 0. 模块总览（插件侧）

| 文件 | 职责 |
|---|---|
| `src/plugin.ts` | 服务端插件入口：挂 hooks、建 v2 client、事件路由 |
| `src/transparency.ts` | **透明修复核心**：记住原始命令、定位 part、还原 input |
| `src/controller.ts` | 状态机（disabled/initializing/active/error/pending-refresh）+ 生命周期 |
| `src/adapter.ts` | 产品策略 → SRT config，`wrapWithSandbox` 唯一调用者 |
| `src/permission-bridge.ts` | SRT askCallback ↔ 待决 ask 队列 ↔ TUI 决策 |
| `src/runtime-store.ts` | server↔TUI 共享状态文件 `~/.config/opencode-sandbox/runtime.json` |
| `src/tui-protocol.ts` | `tui.command.execute` 协议 encode/decode |
| `src/tui/index.tsx` | TUI 插件：左下角入口 + 授权弹窗 + 开关 |
| `src/debug.ts` | 调试日志 `~/.config/opencode-sandbox/debug.log` |

---

## 1. 数据流 A：bash 沙箱化执行 + 透明抽象（核心，D6）

> 一句话：**执行用包装命令、展示/存储/LLM 用原始命令**。包装前记住原始，执行后还原 part。

### ① LLM 发起 bash tool call（part 初建，input = 原始命令）

```
LLM stream → "tool-call" 事件
```
- `opencode/opencode/src/session/processor.ts:329` — `tool-call` 事件处理
- `opencode/opencode/src/session/processor.ts:214` — `ensureToolCall` 创建 tool part，`state.input = {}` 初始为空
- `opencode/opencode/src/session/processor.ts:335` — `updateToolCall` 把 **LLM 传入的原始 args** 写进 `state.input`

→ 此刻 part 里是 `{ command: "curl baidu.com" }`，**还没有 bwrap**。

### ② tool.execute.before（插件包装命令）

`opencode/opencode/src/session/tools.ts:101` — 每个 tool 执行前触发 hook：

```ts
const ctx = context(args, options)                        // tools.ts:101
yield* plugin.trigger("tool.execute.before", …, { args }) // tools.ts:102-106
const result = yield* item.execute(args, ctx)             // tools.ts:107 ← 同一份 args 引用流入真实执行
```

插件侧 `src/plugin.ts:186`：

```ts
async "tool.execute.before"({ tool, sessionID, callID }, output) {
  if (tool !== "bash") return
  if (!controller.isEnabled()) return
  const original = String(output.args.command ?? "")
  controller.ensureExecutable()                                   // fail-closed
  transparency.register(callID, original)                          // ← 记住原始命令（transparency.ts:78）
  output.args.command = await controller.beforeSpawn(...)          // ← 改成 bwrap 包装命令
}
```

**关键点**：`output.args.command` 改写的就是 `args` 这个对象本身，`item.execute(args)` 和内核读到的都是包装命令 → 真实 spawn 是沙箱的。这是唯一注入点（CLAUDE.md D1）。

### ③ shell tool 内部执行（泄漏点出现）

`opencode/opencode/src/tool/shell.ts` execute：

1. `shell.ts:263` `ask()` → `ctx.ask` → 发出 `permission.asked` 事件 → 插件在 `src/plugin.ts:244` 收到，顺手记录 `tool.messageID`（`src/plugin.ts:250`，定向查找用）。
2. `shell.ts:475` `ctx.metadata({metadata:{output:""}})` — 这一步把 args 写进 part：

   `opencode/opencode/src/session/tools.ts:64-77` metadata 函数：
   ```ts
   state: { …, input: args, … }   // tools.ts:73 ← 此刻 args.command 是 bwrap！
   ```
   → **part.state.input.command 暂时变成 bwrap**（唯一泄漏点，插件在此阶段够不到）。
3. `shell.ts:484` `spawner.spawn(cmd(input.shell, input.command, …))` — 真实 bwrap 边界生效。
4. `shell.ts:586` 返回 `title: input.command`（wrapped）。

### ④ tool.execute.after（插件还原）

`opencode/opencode/src/session/tools.ts:117` 触发 after hook。插件侧 `src/plugin.ts:195`：

```ts
const original = transparency.peekOriginal(callID)
if (original !== undefined) output.title = original     // ← 标题立即还原（plugin.ts:198）
const messageID = transparency.peekMessageID(callID)
setTimeout(() => {                                       // ← 延迟 250ms，见 §5.3
  void withTimeout(transparency.repair(client, sessionID, callID, messageID), 5000).catch(() => {})
}, 250)
controller.afterSpawn(callID)
```

`src/transparency.ts:118` `repair()`：

```ts
const original = this.takeOriginal(callID)          // 消费原始命令（transparency.ts:103/119）
const part = await this.findPart(...)                // 定位 tool part（transparency.ts:144）
await client.part.update({                           // ← 还原 input.command（transparency.ts:129）
  …,
  part: { ...part, state: { ...part.state, input: { ...input, command: original } } },
})
```

`findPart` 两种查找路径（`src/transparency.ts:144`）：
- **快路径**：有 messageID 提示 → `client.session.message({sessionID, messageID})` 只拉一条消息（transparency.ts:152）
- **慢路径回退**：`client.session.messages({sessionID})` 全量扫描（transparency.ts:157）

两者都要解包 v2 SDK 的 `{ data, request, response }` 包装（`unwrapArray` transparency.ts:54 / `unwrapMessage` transparency.ts:63）。

### ⑤ part 完成（保留修复后的原始命令）

`opencode/opencode/src/session/processor.ts:381` `tool-result` → `completeToolCall`（processor.ts:160）：

```ts
state: { status: "completed", input: match.part.state.input, …, title: output.title }
```
`input` 取当前 part 的 input —— 若 ④ 已修复，这里保留的就是原始命令。

### ⑥ TUI 渲染 `$ <command>` 行

`opencode/tui/src/routes/session/index.tsx:2074`：

```tsx
<Show when={isRunning()} fallback={<text fg={theme.text}>$ {stringValue(props.input.command)}</text>}>
  <Spinner color={theme.text}>{stringValue(props.input.command)}</Spinner>
</Show>
```
`props.input.command` = `part.state.input.command`。**修复成功 → 显示原始命令；修复失败 → 停留 bwrap**（这就是你之前看到 bwrap 的原因）。

part.update 成功后 server 广播 `message.part.updated` SSE → TUI 自动重渲染。

### ⑦ part.update 的 server 端点

`opencode/opencode/src/server/routes/instance/httpapi/handlers/session.ts:395` `updatePart`：
校验 payload 的 `id/messageID/sessionID` 与路径参数一致（否则 BadRequest），再 `session.updatePart(payload)`（handlers/session.ts:408）。

### ⑧ v2 client 的传输（为什么现在能通）

`src/plugin.ts:34` `createV2Client` + `src/plugin.ts:65` `extractInProcessFetch`：

```
编译版 opencode：Server.url = undefined（TUI+server 同进程，无 TCP）
  → input.serverUrl 回退 http://localhost:4096（死端口）→ HTTP 调用挂起
  → 从 input.client（v1 SDK，opencode 注入了进程内 fetch）借出 fetch：
     input.client._client.getConfig().fetch   ==  Server.Default().app.fetch
  → 传给 v2 client → part.update 进程内直达 server
```

opencode 注入进程内 fetch 的位置：`opencode/opencode/src/plugin/index.ts:142`（`createOpencodeClient` + `...(serverUrl ? {} : { fetch: … Server.Default().app.fetch … })`），`input.serverUrl` getter 在 plugin/index.ts:159。

---

## 2. 数据流 B：网络授权（SRT ask → TUI 弹窗 → 决策回写）

```
SRT 拦截未允许域名 → askCallback
  → controller → PermissionBridge.handleAsk          permission-bridge.ts:75
      ├─ 同 host 并发去重（map 里已有则共享一个 pending）
      ├─ 生成 ask id，挂起 Promise<boolean>（最多 15s，超时自动 deny）
      └─ pendingAsks() → runtime.json               runtime-store.ts:44 writeRuntime
  → TUI 轮询 runtime.json 读 asks[]                  tui/index.tsx:122
      ├─ 防抖 700ms 合并突发（redirect 链多 host）    tui/index.tsx:148-155
      └─ showAsk → api.ui.dialog.replace 弹三选      tui/index.tsx:89-120
  → 用户选择 → tui.publish 发回 server                tui/index.tsx:68
      └─ encodeTuiCommand                            tui-protocol.ts:52
  → server event hook 收到 tui.command.execute       plugin.ts:211
      └─ bridge.resolve(id, {allow,persist})          permission-bridge.ts:116
          ├─ persist=true → controller.allowNetwork()（写 allowlist + updateConfig 即时生效）controller.ts:185
          └─ settle → resolve(true/false) → SRT 放行/拒绝当前连接
```

- 协议类型：`src/tui-protocol.ts:14` `SandboxTuiCommand`
- server→TUI 为什么走文件：SSE 事件方向在编译版不可达（见 CLAUDE.md §7 变体）

---

## 3. 数据流 C：TUI 开关 → server

```
TUI 左下角 app_bottom slot 静态入口 "Sandbox"       tui/index.tsx:202-204
  → 点击 → DialogConfirm（读 runtime 显示当前状态）   tui/index.tsx:173-180
  → 确认 → tui.publish sandbox.toggle               tui/index.tsx:68
  → server event hook：case "sandbox.toggle"         plugin.ts:221
      → controller.enable() / disable()              controller.ts:69 / 218
  → onStateChange → refreshRuntime → runtime.json    plugin.ts:133-135
```

---

## 4. 数据流 D：状态同步（server → TUI，走共享文件）

```
controller 状态变化 / ask 变化 → refreshRuntime      plugin.ts:135
  → writeRuntime(runtime.json, {state,enabled,asks,…})  runtime-store.ts:44
TUI 每次重绘 / 轮询读                              tui/index.tsx:40 readState
  → 状态变化弹 toast「已启用/已关闭」                 tui/index.tsx:123-134
```

---

## 5. 关键机制（为什么能工作）

### 5.1 透明抽象 = 两个视图
- **执行视图**：`args.command`（bwrap）→ 只用于真实 spawn。
- **存储/展示视图**：`part.state.input.command`（原始）→ TUI、DB、LLM 上下文全用它。
- 切换靠 `TransparencyRepair` 的 `Map<callID, original>`：`register`（transparency.ts:78）在包装前写入，`repair`（transparency.ts:118）在 after 消费还原。

### 5.2 之前泄漏的两个根因（都已修）
1. **响应形状 bug**：v2 SDK 的 `session.messages()` 返回 `{data,request,response}` 而非裸数组，`findPart` 迭代包装对象找不到 part → 修复静默跳过。→ `unwrapArray/unwrapMessage`（transparency.ts:54/63）。
2. **传输 bug**：编译版 `Server.url` undefined → HTTP 指向死端口挂起 → 修复没执行。→ 借 `input.client` 的进程内 fetch（plugin.ts:65）。

### 5.3 为什么 repair 延迟 250ms
`completeToolCall`（processor.ts:160）会把 part 从 `running` 标为 `completed`。若 repair 读得太早（拿到 `running`），把修复后的 `running` 写回会把 part 卡死在 running。延迟后读到的必是 completed，`{...part.state}` 原样保留 status，只改 `input.command`。

### 5.4 执行中仍会短暂闪现 bwrap（架构限制）
`ctx.metadata`（tools.ts:73）在执行中途就把包装后的 args 写进 part，插件在此阶段够不到。但每次命令结束后 ~300ms 内被还原，**不"停留"**。要彻底消除需改 opencode 内核，不在 v1 范围。

### 5.5 LLM 为什么永远看不到 bwrap
LLM 下一轮看到的 tool call 是 `input + title = 原始命令`（repair 还原 input + `output.title` 同步修正）。bwrap 前缀从不出现在 LLM 上下文 → 无从模仿嵌套、token 不爆炸。

---

## 6. 验收 / 调试对照表

| 现象 | 看哪里 |
|---|---|
| 弹窗重复弹 | `tui/index.tsx` 防抖逻辑（148-155） |
| 弹窗不出现 | `runtime.json` 的 `asks[]` 是否写入；`permission-bridge.ts:75` |
| bwrap 停留 | `~/.config/opencode-sandbox/debug.log`：`createV2Client:fetch in-process` 应出现；`transparency:repaired` 应出现 |
| debug.log 显示 `http`（非 in-process） | `extractInProcessFetch` 失败，检查 `input.client._client.getConfig().fetch` |
| debug.log 显示 `part-not-found` | `findPart` 定位失败，检查 messageID 提示/全量扫描 |
| 开关无反应 | `runtime.json` 的 `state` 是否变化；`plugin.ts:221` sandbox.toggle |
