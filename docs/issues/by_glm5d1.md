# AICoder Code Review — by glm-5.1

> 审查范围：排除安全漏洞（密码明文、命令注入）和数据安全（Worktree 删除）
> 审查时间：2026-04-05

---

## P0 — 功能性 Bug（立即修复）

### 1. Report 页面 URL 参数不匹配

**文件**: `frontend/status.ts:358` vs `frontend/report.ts:27`

Status 页 pipeline 完成后跳转 Report 页传 `session` 参数，但 Report 页读取 `id` 参数。**用户永远看不到报告。**

```typescript
// status.ts 传 session 参数
window.location.href = `report.html?session=${data.session_id}`;

// report.ts 读取 id 参数
return params.get('id');  // null → "No session ID provided"
```

**修复**: 统一为 `session` 或 `id`。

**工作量**: 5 分钟

---

## P1 — 高优先级

### 2. 手写 YAML 解析器会截断数据

**文件**: `server/pipeline.ts:292-368`

76 行手写 YAML 解析器通过 `split(':')` 取值，如果 output/error 内容包含 `:` 会被截断。多行值完全不支持。

```typescript
// "error: Something went wrong: details" → 只取到 "Something went wrong"
result.stages![currentStage].error = trimmed.split(':')[1].trim();
```

**修复**: 使用 `js-yaml` 库，或改用 JSON 序列化（反正前后端都是 TS，YAML 不是必须的）。

**工作量**: 2 小时

---

### 3. Pipeline 轮询最长 50 分钟无取消机制

**文件**: `server/pipeline.ts:641-643`

```typescript
maxAttempts = 600,
pollIntervalMs = 5000
// 最长等待 600 × 5s = 50 分钟
```

- 无 `AbortController` 支持
- 无全局 pipeline 超时
- 如果 OpenCode 进程在 `executePipeline` 期间 crash，pipeline 状态卡在 `running`（只有 server 重启时才清理孤儿 session）
- Node 进程 crash 时异步 pipeline 错误丢失，session 永久卡在 `pending`/`running`

**修复**: 添加 `AbortController`、全局超时（如 30 分钟）、进程健康检查。

**工作量**: 4 小时

---

### 4. npm test 和 npm lint 都是占位脚本

**文件**: `package.json:9-10`

```json
"test": "echo \"No tests yet\" && exit 0",
"lint": "echo \"No linter yet\" && exit 0"
```

实际存在 12 个测试文件（`server/*.test.ts`、`schemas/*.test.ts`、`tests/e2e.test.ts`），但 npm test 从未执行它们。已知的测试断言与代码不匹配（`docs/issues/P1-high.md #3`）。

**修复**:
- 接入 Bun test runner（`bun test`）
- 接入 ESLint + Prettier
- 修复已知断言不匹配

**工作量**: 1 天

---

### 5. Zod Schema 定义但从未在 Pipeline 中使用

**文件**: `schemas/*.schema.ts` (7 个文件)

Zod schema 定义了完整的数据契约（clarify、design、task、dev、test、review、validate），但 `pipeline.ts` 中的 `STAGE_VALIDATION` 只是字符串检查列表，从未调用 Zod schema 做运行时验证。schema 文件形同虚设。

```typescript
// pipeline.ts — 这只是文本指令，不是代码验证
const STAGE_VALIDATION: Record<PipelineStage, string> = {
  clarify: `- MUST return either: status = "confirmed"...`,
};
```

**修复**: 在 `readStageOutput()` 后调用对应 Zod schema 校验。

**工作量**: 4 小时

---

### 6. WebSocket 和 HTTP 轮询状态冲突

**文件**: `frontend/status.ts:86-97, 186-223`

两个独立数据源同时更新 UI，没有主从关系和版本控制：
- WebSocket 收到的 progress 事件可能被下一次 HTTP poll 覆盖
- HTTP poll 的 `fetchSessionStatus()` 和 WebSocket 的 `handleProgressUpdate()` 都更新 DOM，无冲突解决

**修复**: WebSocket 为主，连接成功时停止 HTTP 轮询；断开时恢复轮询。或引入版本号。

**工作量**: 1 天

---

### 7. 构建脚本静默失败

**文件**: `package.json:8`

```json
"build": "tsc && cp frontend/*.html frontend/*.css dist/frontend/ 2>/dev/null || true"
```

`2>/dev/null || true` 意味着 HTML/CSS 复制失败时完全无提示。生产部署可能是空的 frontend，但 build 仍然成功退出。

**修复**: 移除 `|| true`，正确处理错误。

**工作量**: 10 分钟

---

## P2 — 中等优先级

### 8. 死依赖 `eventsource`

**文件**: `package.json:16`

```json
"eventsource": "^4.1.0"
```

`server/opencode.ts` 中 SSE 实现用的是原生 `fetch` + `ReadableStream`，没有 import `eventsource`。

**修复**: `npm uninstall eventsource`

**工作量**: 1 分钟

---

### 9. `bun-types` 版本过旧

**文件**: `package.json:22`

```json
"bun-types": "^1.0.0"
```

Bun 当前版本已到 1.1.x+，类型定义可能不匹配。

**修复**: 更新到 `"^1.1.0"` 或最新。

**工作量**: 5 分钟

---

### 10. Zod v4 兼容性风险

**文件**: `package.json:18`

```json
"zod": "^4.3.6"
```

Zod 4.x 是全新大版本，生态中大部分用法和文档仍基于 3.x。`z.infer` 等行为可能不同。

**修复**: 确认所有 Zod 用法与 v4 兼容，或降级到 `"^3.23.0"`。

**工作量**: 2 小时（验证）或 30 分钟（降级）

---

### 11. 前后端验证逻辑重复

**文件**: `server/validation.ts` vs `frontend/create.ts`

两套完全独立的验证逻辑（projectName、requirements、techStack 等），规则完全相同但各自实现。修改一边时容易忘记另一边。

**修复**: 将验证规则抽取为共享的 JSON 配置，或生成前端验证代码。

**工作量**: 1 天

---

### 12. `broadcastEvent` 到处 `as any`

**文件**: `server/routes.ts:429, 440, 474, 490`

```typescript
(fastify as any).broadcastEvent(event);
```

`broadcastEvent` 通过 `fastify.decorate` 注册但 TypeScript 类型没有扩展，4 处使用 `as any`。

**修复**: 声明 Fastify 类型扩展。

```typescript
declare module 'fastify' {
  interface FastifyInstance {
    broadcastEvent(event: SSEEvent): void;
  }
}
```

**工作量**: 15 分钟

---

### 13. `STAGE_ORDER` / `PipelineStage` 重复定义

**文件**:
- `server/pipeline.ts:77` — `STAGE_ORDER` 定义
- `frontend/status.ts:39` — `STAGE_ORDER` 完全相同的重新定义
- `server/pipeline.ts:19-28` — `PipelineStage` 类型
- `frontend/status.ts:8-9` — `PipelineStage` 类型重新定义

**修复**: 抽取到 `shared/types.ts`（前后端共享）。

**工作量**: 1 小时

---

### 14. 前端 Clipboard 复制代码重复

**文件**: `frontend/status.ts:448-475` 和 `483-511`

两段几乎相同的 `navigator.clipboard.writeText` + fallback 代码，仅变量名不同。

**修复**: 抽取 `copyToClipboard(text: string, btn: HTMLButtonElement)` 工具函数。

**工作量**: 30 分钟

---

### 15. 端口分配无系统碰撞检测

**文件**: `server/opencode.ts:79-88`

`allocatePort()` 在 20000-30000 范围随机取端口，只检查进程内 `usedPorts` Set。不检测端口是否被系统其他进程占用。

**修复**: 尝试 `bind()` 端口确认可用，或使用 `get-port` 类库。

**工作量**: 1 小时

---

### 16. OpenCode 进程启动超时太短

**文件**: `server/opencode.ts:186-190`

```typescript
}, 5000); // 5 秒
```

首次启动加载多个 provider 时可能需要更长时间。失败后进程被 kill，无重试。

**修复**: 增加到 15-30 秒，或支持环境变量配置。

**工作量**: 30 分钟

---

## P3 — 低优先级 / 代码质量

### 17. 12+ 处空 catch 块静默吞错误

| 文件 | 位置 |
|------|------|
| `server/routes.ts` | L91, L97, L107, L142, L296, L429, L473, L489 |
| `server/pipeline.ts` | L179, L382, L697-709 |
| `server/opencode.ts` | L157 |
| `frontend/status.ts` | L457, L469, L491, L505 |
| `frontend/index.ts` | L70 |

**修复**: 至少 `console.warn` 或 `fastify.log.warn` 记录错误。

**工作量**: 2 小时

---

### 18. 硬编码配置值

| 值 | 出现位置 | 次数 |
|----|---------|------|
| `'kimi-for-coding/k2p5'` | routes.ts、create.ts、opencode.ts | 4 |
| 端口范围 `20000-30000` | opencode.ts | 1 |
| 重试延迟 `[2000, 5000, 10000]` | pipeline.ts | 1 |
| 轮询间隔 `2500ms`、`5000ms` | routes.ts、pipeline.ts | 2 |
| DB 路径 `'./aicoder.db'` | db.ts | 1 |
| 缓存 TTL `5 * 60 * 1000` | routes.ts | 1 |

**修复**: 抽取到 `config.ts` 或环境变量。

**工作量**: 2 小时

---

### 19. 无结构化日志

**文件**: `server/opencode.ts:52-69`

使用手写 `console.log/error` 输出日志，格式 `` `[${ts}] [opencode:${component}] ${msg}` ``，无结构化，无法过滤、聚合。

**修复**: 接入 `pino`（Fastify 默认 logger）或至少统一日志接口。

**工作量**: 3 小时

---

### 20. 无 Lint / Formatter 配置

**文件**: 无 `.eslintrc*`、`.prettierrc*`、`.editorconfig`

代码风格一致性完全靠人工。

**修复**: 接入 ESLint + Prettier。

**工作量**: 2 小时

---

### 21. 缺少 `.env.example`

项目使用 `PORT`、`HOST`、`OPENCODE_BIN_PATH` 等环境变量，但没有 `.env.example` 文件。`.gitignore` 正确排除了 `.env`，但新开发者不知道需要配置什么。

**工作量**: 15 分钟

---

### 22. `skipLibCheck: true` 隐藏依赖类型错误

**文件**: `tsconfig.json:9`

跳过 `.d.ts` 类型检查，可能隐藏依赖类型问题。

**工作量**: 0（已知取舍，可接受）

---

## 修复优先级总结

| 优先级 | # | 问题 | 风险 | 工作量 |
|--------|---|------|------|--------|
| **P0** | 1 | Report URL 参数不匹配 | 🔴 功能断裂 | 5min |
| **P1** | 2 | YAML 解析器截断数据 | 🟠 数据损坏 | 2h |
| **P1** | 3 | Pipeline 50min 无取消 | 🟠 资源浪费 | 4h |
| **P1** | 4 | Test/Lint 占位脚本 | 🟠 质量无保障 | 1d |
| **P1** | 5 | Zod Schema 未使用 | 🟠 代码虚设 | 4h |
| **P1** | 6 | WS/HTTP 状态冲突 | 🟠 UI 闪烁 | 1d |
| **P1** | 7 | 构建脚本静默失败 | 🟠 部署隐患 | 10min |
| **P2** | 8-16 | 依赖/重复/类型 | 🟡 维护负担 | 各 1h |
| **P3** | 17-22 | 空catch/硬编码/日志 | 🔵 代码规范 | 各 1-3h |

**建议执行顺序**: #1 (5min) → #7 (10min) → #8 (1min) → #4 (启用测试) → #2 → #5 → #3 → 其余
