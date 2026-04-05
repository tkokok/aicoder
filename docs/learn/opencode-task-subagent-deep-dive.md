# OpenCode `task` 工具与 Subagent 执行机制深度解析

> 研究日期：2026-04-04  
> 源码来源：
> - `~/workspace-aicoder/opencode` (OpenCode 原生服务端)
> - `~/workspace-aicoder/oh-my-openagent` (oh-my-openagent 插件)

---

## 1. OpenCode 原生 `task` 工具的实现机制

### 1.1 核心文件

| 文件 | 职责 |
|------|------|
| `packages/opencode/src/tool/task.ts` | `task` 工具定义：参数校验、子 session 创建/恢复、调用子 session 的 `prompt()` |
| `packages/opencode/src/session/prompt.ts` | `handleSubtask()`：父 session 阻塞等待子 session 完成 |
| `packages/opencode/src/effect/runner.ts` | `Runner`：通过 `Deferred.await()` 确保同一会话串行执行 |
| `packages/opencode/src/bus/index.ts` | 通用事件总线，用于 UI/CLI 观察进度 |

### 1.2 调用链路

当父 agent 的消息循环遇到 `task` tool call 时：

1. **`task.ts` 创建/恢复子 session**
   ```ts
   const session = await iife(async () => {
     if (params.task_id) {
       const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
       if (found) return found
     }
     return await Session.create({
       parentID: ctx.sessionID,
       title: params.description + ` (@${agent.name} subagent)`,
       permission: [...],
     })
   })
   ```

2. **`task.ts` 在子 session 上执行 `SessionPrompt.prompt()`**
   - 子 session 开始独立运行自己的消息循环。

3. **`prompt.ts` 的 `handleSubtask` 阻塞父 session**
   ```ts
   // packages/opencode/src/session/prompt.ts (lines 616-652)
   const result = yield* Effect.promise((signal) =>
     taskTool
       .execute(taskArgs, {
         agent: task.agent,
         messageID: assistantMessage.id,
         sessionID,
         abort: signal,
         callID: part.callID,
         extra: { bypassAgentCheck: true },
         messages: msgs,
         // ...
       })
       .catch((e) => { ... })
   )
   ```
   父 session 的 fiber 直接挂起在 `Effect.promise(...)` 上，直到子 session 的 Promise resolve。

4. **子 session 完成后，父 session 恢复**
   - 更新 tool part 状态：`running` → `completed`
   - 设置 `assistantMessage.finish = "tool-calls"`
   - 父 agent 继续生成后续消息（例如 `write`、`edit`、最终 `finish=stop`）

### 1.3 关键结论：原生 `task` 是阻塞的

- **父 session 会被阻塞**，直到子 agent 完全结束。
- **没有专门的 "subagent completed" 推送事件**。外部观察者只能通过轮询消息列表，观察到：
  1. 某条 assistant 消息里的 `task` tool part 从 `running` 变成 `completed`。
  2. 随后出现新的父 agent 消息（write / stop 等）。

---

## 2. oh-my-openagent 的 `delegate-task` 实现

oh-my-openagent **没有使用原生 `task`**，而是基于 `@opencode-ai/plugin` SDK 自己实现了 `task` 工具（`src/tools/delegate-task/`）。

### 2.1 核心文件

| 文件 | 职责 |
|------|------|
| `src/tools/delegate-task/tools.ts` | `task` 工具定义，根据 `run_in_background` 分派 sync/background |
| `src/tools/delegate-task/sync-task.ts` | Sync 模式：阻塞执行 |
| `src/tools/delegate-task/sync-session-poller.ts` | Sync 模式的轮询器（轮询子 session 状态直到完成） |
| `src/tools/delegate-task/background-task.ts` | Background 模式：立即返回 task_id |
| `src/features/background-agent/manager.ts` | `BackgroundManager`：后台任务的队列、启动、轮询、完成通知 |
| `src/hooks/background-notification/hook.ts` | 将 OpenCode runtime 事件转发给 BackgroundManager |
| `src/hooks/atlas/boulder-continuation-injector.ts` | Atlas 的 orchestrator 逻辑：有后台任务运行时不注入 continuation prompt |

### 2.2 Sync 模式（`run_in_background=false`）

```ts
// src/tools/delegate-task/sync-task.ts
const promptError = await deps.sendSyncPrompt(client, { ... })
if (promptError) return promptError

const pollError = await deps.pollSyncSession(ctx, client, {
  sessionID,
  agentToUse,
  toastManager,
  taskId,
}, syncPollTimeoutMs)
```

`pollSyncSession` 是一个主动轮询循环：

```ts
// src/tools/delegate-task/sync-session-poller.ts
while (Date.now() - pollStart < maxPollTimeMs) {
  await wait(syncTiming.POLL_INTERVAL_MS)
  const statusResult = await client.session.status()
  const messagesResult = await client.session.messages({ path: { id: sessionID } })
  if (isSessionComplete(msgs)) break
}
```

- 父 agent 的 `task` 工具调用会 **阻塞** 在轮询循环里。
- 与原生 `task` 的区别：oh-my-openagent 是自己轮询子 session 状态，而原生 `task` 是阻塞在子 session 内部 Promise 上。

### 2.3 Background 模式（`run_in_background=true`）

```ts
// src/features/background-agent/manager.ts
private async notifyParentSession(task: BackgroundTask): Promise<void> {
  await this.client.session.promptAsync({
    path: { id: task.parentSessionID },
    body: {
      noReply: !shouldReply,   // 通常 true，避免立即触发父 agent 回复
      parts: [createInternalAgentTextPart(notification)],
    },
  })
}
```

流程：
1. `task` 工具**立即返回** `task_id`，父 agent 继续执行。
2. `BackgroundManager` 通过事件 + 轮询监控子 session。
3. 子 agent 完成后，`notifyParentSession()` **主动向父 session 注入一条通知消息**。
4. 父 agent 在后续运行时会看到这条通知，决定如何继续。

### 2.4 Atlas 的 orchestration 技巧

```ts
// src/hooks/atlas/boulder-continuation-injector.ts
const hasRunningBgTasks = backgroundManager
  ? backgroundManager.getTasksByParentSession(sessionID).some((t) => t.status === "running")
  : false

if (hasRunningBgTasks) {
  log(`[${HOOK_NAME}] Skipped injection: background tasks running`, { sessionID })
  return
}
```

- Atlas 会在后台任务全部完成前，**主动抑制**注入下一个 continuation prompt。
- 这防止了父 agent 在子 agent 尚未完成时盲目推进。

---

## 3. 对 AICoder Stage-Machine 架构的启示

### 3.1 当前架构的问题

当前 AICoder 的 `pipeline.ts` 让**父 agent 承担过多职责**：

```
backend 发 stage prompt → 父 agent 调用 task → 等待子 agent →
父 agent 读取/验证子 agent 输出 → 父 agent write JSON → 父 agent 返回 finish=stop →
backend 检测到 stop，进入下一阶段
```

这导致的问题：
1. **backend 对子 agent 进度一无所知**：只能干等父 agent 最终 stop。
2. **父 agent 恢复后可能犯错**：例如 `write` 传空 `filePath` 导致失败重试（v3 测试里 clarify 重试 3 次）。
3. **轮询效率低**：`pollForResponse` 每 5 秒轮询一次父 session，子 agent 可能已经早早完成，但父 agent 的二次处理拉长了总时间。

### 3.2 理想的改进方向

借鉴 oh-my-openagent 的 orchestration 哲学，考虑让 **backend 直接轮询子 session**，而不是依赖父 agent 中转：

```
backend 发 stage prompt → 父 agent 调用 task → 父 agent 立刻返回 task_id + finish=stop →
backend 拿到 task_id → backend 直接轮询子 session 直到完成 →
backend 读取子 agent 输出或子 agent 已写好的文件 → 进入下一阶段
```

这样做的优势：
- **消除父 agent 写文件失败的风险**：子 agent 自己落地结果，backend 直接读取。
- **backend 精确感知进度**：可以直接看到子 session 的 `finish=stop`。
- **减少无效等待**：子 agent 一完成，backend 立刻推进，无需等父 agent 的二次处理。

### 3.3 两种可行方案

#### 方案 A：Backend 轮询子 session（推荐深入研究）
- 修改 `buildStagePrompt`：父 agent 只负责 dispatch task，返回 `task_id` 和 `stop`。
- backend 新增 `pollSubagentSession(subagentSessionId)` 逻辑。
- 子 agent 的 prompt 里明确要求将结果写入指定路径，backend 直接读取。

**挑战**：
- 需要处理子 agent 超时、失败、需要重试的情况。
- 子 agent 的 `task_id` 需要从父 agent 的返回 JSON 中可靠提取。

#### 方案 B：保持现有架构，但优化父 agent 的 prompt
- 在 prompt 中更加严格地要求父 agent：
  - `write` 必须带正确的 `filePath`。
  - 失败后立即使用 `edit` 或 `write` 修正，不要产生多余思考。
  - 最终只返回 `finish=stop`，不要附加解释。

**挑战**：
- 这只是缓解了问题，没有从根本上解决 backend 对子 agent 的"半盲"状态。

---

## 4. 关键引用索引

### OpenCode 原生源码
- `packages/opencode/src/tool/task.ts` — `task` 工具定义
- `packages/opencode/src/session/prompt.ts:616-652` — `handleSubtask` 阻塞父 session
- `packages/opencode/src/effect/runner.ts:111-139` — `Deferred.await()` 串行执行
- `packages/opencode/src/bus/index.ts` — 事件总线

### oh-my-openagent 源码
- `src/tools/delegate-task/tools.ts` — 任务分派入口
- `src/tools/delegate-task/sync-task.ts` — Sync 阻塞执行
- `src/tools/delegate-task/sync-session-poller.ts` — 子 session 轮询
- `src/features/background-agent/manager.ts:1659-1824` — `notifyParentSession()` 主动注入通知
- `src/hooks/atlas/boulder-continuation-injector.ts` — Atlas 后台任务门控
