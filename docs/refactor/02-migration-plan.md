# 控制面/数据面分离改造落地方案

## 概述

本文档描述如何将现有 AICoder 架构改造为控制面/数据面分离模式。

**目标版本**：v0.7.0  
**预计工期**：2-3 周  
**风险等级**：中等（需保证现有功能不中断）

## 当前代码分析

### 需要拆分的模块

```
server/
├── index.ts          # Fastify 启动（控制面）
├── routes.ts         # API 路由 + OpenCode 调用（混合）
├── pipeline.ts       # 管道执行 + 文件轮询（需移到数据面）
├── opencode.ts       # OpenCode 客户端（需移到数据面）
├── db.ts             # SQLite（保留在控制面）
└── prompts/          # Playbook 生成（保留在控制面）
```

### 改造范围

| 文件 | 当前职责 | 改造后位置 | 改动量 |
|------|----------|------------|--------|
| `index.ts` | Fastify 启动 | 控制面 | 小 |
| `routes.ts` | API + OpenCode 管理 | 拆分到两面 | 大 |
| `pipeline.ts` | 管道执行 | 数据面 | 大 |
| `opencode.ts` | OpenCode 客户端 | 数据面 | 中 |
| `db.ts` | SQLite | 控制面（保留） | 无 |
| `websocket.ts` | WebSocket | 控制面 | 小 |

## 阶段一：代码分层（第 1 周）

### 1.1 创建目录结构

```
server/
├── control/              # 控制面代码
│   ├── index.ts         # Fastify 入口
│   ├── routes.ts        # API 路由（简化）
│   ├── websocket.ts     # WebSocket（移动）
│   └── client/          # 数据面客户端
│       └── agent-client.ts
├── data/                # 数据面代码
│   ├── index.ts         # Agent HTTP 服务入口
│   ├── pipeline.ts      # 管道执行（从根移动）
│   ├── opencode.ts      # OpenCode 客户端（从根移动）
│   ├── filesystem.ts    # 文件操作封装
│   └── callback.ts      # 回调控制面逻辑
├── shared/              # 共享代码
│   ├── types.ts         # 类型定义
│   └── constants.ts     # 常量
└── db.ts               # 数据库（保持不动）
```

### 1.2 提取共享类型

创建 `server/shared/types.ts`：

```typescript
// 从 pipeline.ts 提取
export type PipelineStage = 'clarify' | 'design' | 'task' | 'dev' | 'test' | 'review' | 'validate';
export type PipelineMode = 'full' | 'standard' | 'simple';

// 新增：数据面 API 类型
export interface DataPlaneAPI {
  startPipeline(req: StartPipelineRequest): Promise<StartPipelineResponse>;
  stopPipeline(pipelineId: string): Promise<void>;
  getStageOutput(sessionId: string, stage: PipelineStage): Promise<StageOutput | null>;
  listFiles(workspaceDir: string): Promise<string[]>;
}

// 回调类型
export interface StageCompleteCallback {
  sessionId: string;
  stage: PipelineStage;
  status: 'completed' | 'failed';
  output: Record<string, unknown>;
  error?: string;
  timestamp: number;
}
```

### 1.3 改造数据面文件操作

创建 `server/data/filesystem.ts`：

```typescript
import { readFile, writeFile, mkdir, watch } from 'fs/promises';
import { join } from 'path';

export class LocalFileSystem {
  constructor(private projectDir: string) {}

  async readStageOutput(sessionId: string, stage: string) {
    const path = join(this.projectDir, `run-${sessionId}`, `${stage}.json`);
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  }

  async watchPipeline(sessionId: string, onStageComplete: (stage: string, data: unknown) => void) {
    const runDir = join(this.projectDir, `run-${sessionId}`);
    // 使用 fs.watch 或轮询
    const watcher = watch(runDir, (eventType, filename) => {
      if (filename?.endsWith('.json')) {
        const stage = filename.replace('.json', '');
        this.readStageOutput(sessionId, stage).then(data => {
          onStageComplete(stage, data);
        });
      }
    });
    return () => watcher.close();
  }
}
```

### 1.4 创建数据面 HTTP 服务

创建 `server/data/index.ts`：

```typescript
import { serve } from 'bun';
import { pipelineHandler } from './pipeline';
import { filesystemHandler } from './filesystem';

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || 'http://localhost:8080';
const CONTROL_PLANE_TOKEN = process.env.CONTROL_PLANE_TOKEN;

const server = serve({
  port: process.env.AGENT_PORT || 8443,
  
  async fetch(request) {
    const url = new URL(request.url);
    
    // 路由分发
    if (url.pathname === '/pipeline/start' && request.method === 'POST') {
      return await pipelineHandler.start(request);
    }
    
    if (url.pathname.startsWith('/output/') && request.method === 'GET') {
      const stage = url.pathname.split('/')[2];
      const sessionId = url.searchParams.get('sessionId');
      return await filesystemHandler.getOutput(sessionId!, stage);
    }
    
    if (url.pathname === '/health') {
      return new Response('ok');
    }
    
    return new Response('Not Found', { status: 404 });
  }
});

console.log(`Data plane agent listening on port ${server.port}`);
```

## 阶段二：改造管道执行（第 1-2 周）

### 2.1 移除文件轮询逻辑

当前 `pipeline.ts` 的轮询循环（499-565 行）需要重构：

```typescript
// 旧代码：控制面轮询本地文件
while (true) {
  await delay(PIPELINE_POLL_INTERVAL_MS);
  const stageStatuses = await readStageStatuses(...);  // 读本地文件
  // ...
}

// 新代码：数据面监控，回调通知
// 在 data/pipeline.ts 中：
export async function executePipeline(options: ExecutePipelineOptions) {
  const { sessionId, projectDir } = options;
  const fs = new LocalFileSystem(projectDir);
  
  // 启动文件监控
  const stopWatching = await fs.watchPipeline(sessionId, async (stage, data) => {
    // 回调控制面
    await notifyControlPlane({
      sessionId,
      stage,
      status: data.status,
      output: data.output,
      timestamp: Date.now()
    });
  });
  
  // 启动 OpenCode 执行
  await startOpenCodeExecution(options);
  
  // 清理
  return {
    stop: () => stopWatching()
  };
}
```

### 2.2 创建回调机制

创建 `server/data/callback.ts`：

```typescript
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL;
const CALLBACK_TOKEN = process.env.CALLBACK_TOKEN;

export async function notifyControlPlane(event: StageCompleteCallback) {
  const response = await fetch(`${CONTROL_PLANE_URL}/api/internal/stage-complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CALLBACK_TOKEN}`
    },
    body: JSON.stringify(event)
  });
  
  if (!response.ok) {
    console.error('Failed to notify control plane:', await response.text());
    // 可加入重试队列
  }
}
```

### 2.3 控制面接收回调

在 `server/control/routes.ts` 新增：

```typescript
// POST /api/internal/stage-complete
fastify.post('/api/internal/stage-complete', async (request, reply) => {
  // 验证 token
  const token = request.headers.authorization?.replace('Bearer ', '');
  if (token !== process.env.CALLBACK_TOKEN) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  
  const event = request.body as StageCompleteCallback;
  
  // 更新数据库
  await updateStageStatus(event.sessionId, event.stage, {
    status: event.status,
    output: event.output,
    error: event.error
  });
  
  // 推送到前端
  fastify.broadcastEvent({
    type: 'stage_complete',
    properties: event
  });
  
  return { ok: true };
});
```

## 阶段三：改造控制面 API（第 2 周）

### 3.1 创建数据面客户端

创建 `server/control/client/agent-client.ts`：

```typescript
export class AgentClient {
  private baseUrl: string;
  
  constructor(agentUrl: string) {
    this.baseUrl = agentUrl.replace(/\/$/, '');
  }
  
  async startPipeline(params: StartPipelineParams) {
    const response = await fetch(`${this.baseUrl}/pipeline/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    
    if (!response.ok) {
      throw new Error(`Agent error: ${response.status}`);
    }
    
    return await response.json();
  }
  
  async getStageOutput(sessionId: string, stage: string) {
    const response = await fetch(
      `${this.baseUrl}/output/${stage}?sessionId=${encodeURIComponent(sessionId)}`
    );
    if (!response.ok) return null;
    return await response.json();
  }
}
```

### 3.2 改造会话创建流程

当前 `routes.ts` 的会话创建（229-541 行）需要调整：

```typescript
// 旧代码：直接执行 pipeline
executePipeline({...}).then(...).catch(...)

// 新代码：调用数据面
fastify.post('/api/sessions', async (request, reply) => {
  // ... 验证和创建记录 ...
  
  // 获取或创建数据面 Agent
  const agentUrl = await getAgentForSession(sessionId, mode);
  const agentClient = new AgentClient(agentUrl);
  
  // 调用数据面启动管道
  try {
    await agentClient.startPipeline({
      sessionId,
      playbook: buildPlaybook(...),
      workspaceDir: workspaceDir,  // 数据面本地路径
      mode: pipelineMode
    });
    
    return reply.status(201).send({ id: sessionId, status: 'pending' });
  } catch (error) {
    return reply.status(502).send({ error: 'Failed to start pipeline on agent' });
  }
});
```

### 3.3 Agent 路由/发现

创建 `server/control/agent-registry.ts`：

```typescript
// 简单实现：本地模式 Agent 与控制面同进程
// 远程模式：从配置或注册中心获取

export async function getAgentForSession(sessionId: string, mode: 'local' | 'remote') {
  if (mode === 'local') {
    // 本地模式：直接返回本地地址
    return 'http://localhost:8443';
  }
  
  // 远程模式：从配置或数据库获取可用 Agent
  // 未来可扩展为调度器
  const agent = await db.agents.findOne({ status: 'online' });
  return agent?.url;
}
```

## 阶段四：配置与部署（第 3 周）

### 4.1 环境变量配置

创建 `.env.example`：

```bash
# 控制面配置
CONTROL_PLANE_PORT=8080
CONTROL_PLANE_CALLBACK_TOKEN=secret_token_for_callbacks
DATABASE_URL=postgresql://user:pass@localhost/aicoder

# 数据面配置（在数据面机器上设置）
AGENT_PORT=8443
AGENT_CONTROL_PLANE_URL=https://api.aicoder.example.com
AGENT_CONTROL_PLANE_TOKEN=secret_token_for_callbacks
AGENT_OPENCODE_URL=http://localhost:4096  # 或外部地址

# 运行模式
MODE=local  # local 或 remote
```

### 4.2 本地模式兼容

当 `MODE=local` 时，控制面与数据面同进程运行：

```typescript
// server/control/index.ts
if (process.env.MODE === 'local') {
  // 启动内置数据面
  const { startDataPlane } = await import('../data/index');
  await startDataPlane({ port: 8443, inline: true });
  
  // 配置 AgentClient 使用本地地址
  process.env.DEFAULT_AGENT_URL = 'http://localhost:8443';
}
```

### 4.3 Docker 部署

创建 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  # 控制面
  control-plane:
    build:
      context: .
      dockerfile: Dockerfile.control
    ports:
      - "8080:8080"
    environment:
      - DATABASE_URL=postgresql://db:5432/aicoder
      - CALLBACK_TOKEN=${CALLBACK_TOKEN}
    depends_on:
      - db

  # 数据面（可与控制面分离部署）
  data-plane:
    build:
      context: .
      dockerfile: Dockerfile.data
    environment:
      - CONTROL_PLANE_URL=http://control-plane:8080
      - CONTROL_PLANE_TOKEN=${CALLBACK_TOKEN}
      - OPENCODE_URL=http://opencode:4096
    # 与 OpenCode 同网络
    network_mode: service:opencode

  opencode:
    image: opencode:latest
    ports:
      - "127.0.0.1:4096:4096"  # 仅本地访问
```

## 阶段五：测试与迁移（第 3 周）

### 5.1 测试矩阵

| 场景 | 测试内容 | 预期结果 |
|------|----------|----------|
| 本地模式 | 控制面+数据面同进程 | 功能与现有一致 |
| 远程模式 | 控制面与数据面分离 | 跨机器通信正常 |
| 回调中断 | 控制面临时宕机 | 数据面重试机制工作 |
| Agent 重启 | 数据面重启后恢复 | 控制面重新连接 |

### 5.2 渐进式迁移策略

1. **v0.7.0-alpha**：代码分层，本地模式运行
2. **v0.7.0-beta**：支持远程 Agent，内部测试
3. **v0.7.0**：正式发布，文档完善

### 5.3 回滚方案

```typescript
// 在控制面保留开关
const USE_DATA_PLANE = process.env.USE_DATA_PLANE === 'true';

if (!USE_DATA_PLANE) {
  // 回退到旧逻辑（直接执行 pipeline.ts）
  return await legacyExecutePipeline(...);
}
```

## 风险与缓解

| 风险 | 可能性 | 缓解措施 |
|------|--------|----------|
| 回调丢失 | 中 | 数据面本地队列 + 重试机制 |
| Agent 失联 | 中 | 健康检查 + 备用 Agent 切换 |
| 性能下降 | 低 | 本地模式保持现有性能 |
| 复杂度增加 | 高 | 本地模式作为默认，隐藏复杂性 |

## 里程碑

| 日期 | 里程碑 | 验收标准 |
|------|--------|----------|
| 第 1 周末 | 代码分层完成 | 本地模式运行正常 |
| 第 2 周末 | 数据面实现完成 | 回调机制工作 |
| 第 3 周中 | 远程模式测试通过 | 跨机器部署成功 |
| 第 3 周末 | v0.7.0 发布 | 文档完整，CI/CD 通过 |

## 附录：文件变更清单

### 新增文件

```
server/control/
  ├── index.ts              # Fastify 入口
  ├── routes.ts             # API 路由（新）
  ├── websocket.ts          # WebSocket（移动）
  └── client/
      └── agent-client.ts   # 数据面客户端

server/data/
  ├── index.ts              # Agent HTTP 服务
  ├── pipeline.ts           # 管道执行（移动）
  ├── opencode.ts           # OpenCode 客户端（移动）
  ├── filesystem.ts         # 文件操作
  └── callback.ts           # 回调控制面

server/shared/
  ├── types.ts              # 共享类型
  └── constants.ts          # 常量
```

### 修改文件

```
server/index.ts             # 改为引用 control/index
server/routes.ts            # 大幅简化，移除 OpenCode 逻辑
server/pipeline.ts          # 移动到 data/
server/opencode.ts          # 移动到 data/
docs/refactor/              # 本文档
```

### 删除文件

```
server/websocket.ts         # 移动到 control/
```
