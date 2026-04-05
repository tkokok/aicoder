# 控制面/数据面分离架构设计

## 背景与问题

当前 AICoder 架构中，后端 Server 直接负责：
- API 路由处理
- OpenCode 进程管理
- 文件系统轮询（读取 `run-{id}/{stage}.json`）
- SQLite 数据库操作

**核心问题**：当 OpenCode 部署在远程时，Server 无法访问其本地文件系统，导致文件轮询失效。

## 目标

1. **位置透明**：无论 OpenCode 本地或远程部署，控制面均能正常工作
2. **安全隔离**：OpenCode 不暴露公网，只接受本地连接
3. **部署灵活**：支持混合部署（部分本地、部分远程）
4. **性能优化**：数据面充分利用 localhost 优势，零网络开销、零认证开销

## 架构设计

### 整体架构

```
                    用户浏览器
                       │
                       ▼ WebSocket/SSE
              ┌─────────────────┐
              │    控制面 Server  │  ← 中心化，可云端部署
              │  (Control Plane)  │
              │                 │
              │  • REST API      │
              │  • WebSocket     │──────► 前端实时状态推送
              │  • PostgreSQL   │
              │  • 任务调度/状态机│
              └────────┬────────┘
                       │ HTTPS/gRPC (短连接，按需)
                       │ mTLS 可选
                       ▼
              ┌─────────────────┐     localhost      ┌──────────────┐
              │   数据面 Agent   │◄─────────────────►│   OpenCode   │
              │  (Data Plane)   │   无认证，直接文件  │   Server     │
              │                 │      访问            │              │
              │  • 本地 HTTP 服务 │                    │  • LLM 执行   │
              │  • 文件 I/O      │                    │  • Agent 执行 │
              │  • 进程管理      │                    │              │
              │  • 本地事件监控  │                    └──────────────┘
              └─────────────────┘
                 与 OpenCode 同域部署
              (本地/远程容器/边缘节点)
```

### 角色定义

#### 控制面 (Control Plane)

- **定位**：中心化协调者
- **部署**：可单点或多副本，推荐云端部署
- **职责**：
  - 对外暴露 REST API / WebSocket
  - 维护全局状态（PostgreSQL）
  - 任务调度与编排
  - 与数据面短连接通信

#### 数据面 (Data Plane / Agent)

- **定位**：OpenCode 的本地代理
- **部署**：与 OpenCode 同机/同容器/同网络
- **职责**：
  - 本地文件 I/O（读取 `run-{id}/*.json`）
  - OpenCode 进程管理（如需要本地启动）
  - 本地事件监控（文件变化、进程状态）
  - 向控制面上报状态

## 通信协议

### 控制面 → 数据面（请求）

| 接口 | 方法 | 用途 |
|------|------|------|
| `/pipeline/start` | POST | 启动管道执行 |
| `/pipeline/{id}/stop` | POST | 停止管道 |
| `/output/{stage}` | GET | 获取阶段输出文件 |
| `/files/list` | GET | 列出工作区文件 |
| `/health` | GET | 健康检查 |

```typescript
// POST /pipeline/start
interface StartPipelineRequest {
  sessionId: string;
  playbook: string;           // 完整 playbook
  workspaceDir: string;       // 工作目录路径（数据面本地路径）
  mode: 'full' | 'standard' | 'simple';
  model?: string;
  reasoningEffort?: string;
}

interface StartPipelineResponse {
  pipelineId: string;
  opencodeSessionId: string;
  status: 'started' | 'failed';
  error?: string;
}

// GET /output/{stage}
interface StageOutputResponse {
  status: 'completed' | 'failed' | 'pending';
  output?: Record<string, unknown>;
  error?: string;
  timestamp: number;
}
```

### 数据面 → 控制面（回调/上报）

数据面通过**回调**向控制面上报事件：

```typescript
// POST https://control-plane/api/internal/stage-complete
interface StageCompleteCallback {
  sessionId: string;
  stage: string;
  status: 'completed' | 'failed';
  output: Record<string, unknown>;
  error?: string;
  timestamp: number;
}

// POST https://control-plane/api/internal/pipeline-status
interface PipelineStatusUpdate {
  sessionId: string;
  currentStage: string;
  overallStatus: 'running' | 'completed' | 'failed';
  stages: Record<string, StageSummary>;
  timestamp: number;
}
```

### 连接模型

| 连接 | 方向 | 类型 | 说明 |
|------|------|------|------|
| 控制面 ↔ 数据面 | 双向 | 短连接 HTTPS | 按需调用，无状态 |
| 数据面 → 控制面 | 单向 | 回调 POST | 事件驱动 |
| 控制面 ↔ 前端 | 双向 | WebSocket/SSE | 长连接，实时推送 |

**关键决策**：控制面与数据面**不需要长连接**。数据面通过回调主动上报，控制面通过短连接查询。

## 部署模式

### 模式一：本地开发（All-in-One）

```
┌─────────────────────────────────────┐
│           开发者机器                 │
│  ┌──────────────┐  localhost:8443  │
│  │ 控制面        │◄────────────────►│
│  │ (简化版)      │                  │
│  └──────┬───────┘                  │
│         │ localhost:8080            │
│  ┌──────┴───────┐                  │
│  │  数据面 Agent │◄──localhost:4096►│
│  └──────────────┘    OpenCode       │
└─────────────────────────────────────┘
```

- 控制面与数据面可同进程（代码层面分离，物理不分离）
- 便于本地开发调试

### 模式二：远程 OpenCode（分离部署）

```
┌─────────────┐         ┌─────────────────────────────┐
│   控制面     │◄───────►│      远程服务器/容器         │
│  (云端)      │  HTTPS  │  ┌─────────────────────┐   │
│             │         │  │    数据面 Agent      │   │
│  PostgreSQL │         │  │  ├─ HTTP Server      │   │
│             │         │  │  ├─ File Watcher     │   │
└─────────────┘         │  │  └─ OpenCode Client  │   │
                        │  │                      │   │
                        │  │  ┌──────────────┐   │   │
                        │  └──►  OpenCode    │   │   │
                        │     │   Server     │   │   │
                        │     └──────────────┘   │   │
                        └─────────────────────────────┘
```

- 控制面部署在云端（如 K8s、ECS）
- 数据面与 OpenCode 同机部署
- 通过 TLS 加密通信

### 模式三：混合部署

```
┌─────────────────────────────────────────────┐
│                控制面 (云端)                  │
└─────────────┬───────────────┬───────────────┘
              │ HTTPS         │ HTTPS
      ┌───────┴──────┐ ┌──────┴──────┐
      ▼              ▼ ▼             ▼
┌──────────┐   ┌──────────┐   ┌──────────┐
│ 数据面 #1 │   │ 数据面 #2 │   │ 数据面 #3 │
│ (本地)    │   │ (远程 A) │   │ (远程 B) │
│ OpenCode │   │ OpenCode │   │ OpenCode │
└──────────┘   └──────────┘   └──────────┘
```

- 支持多个数据面接入同一控制面
- 可按需调度任务到不同数据面

## 安全设计

### 数据面 → OpenCode（本地）

- **无认证**：localhost 通信，信任边界在机器级别
- **无 TLS**：本地明文，无嗅探风险
- **进程隔离**：OpenCode 只监听 127.0.0.1

### 控制面 → 数据面（远程）

- **mTLS 建议**：双向证书认证
- **Token 备选**：共享密钥签名（HMAC）
- **IP 白名单**：控制面出口 IP 限制

### 数据面 → 控制面（回调）

- **JWT Token**：数据面携带预签发 token
- **Timestamp 防重放**：±5 分钟窗口
- **IP 校验**：控制面验证数据面来源

## 状态同步机制

### 旧架构（文件轮询）

```
控制面 ──3秒轮询──► 本地文件
```

**问题**：远程部署失效

### 新架构（事件驱动）

```
AICoder ──write file──► 本地文件
                          │
数据面 ──watch/file polling─┘
  │
  └──回调 POST──► 控制面 ──WebSocket push──► 前端
```

**优势**：
- 事件实时上报，无轮询开销
- 控制面无需关心文件位置
- 前端实时更新

## 文件访问路径

### 数据面视角（本地路径）

```
~/.aicoder/projects/{name}/
├── workspace/              # 代码工作区
├── run-{sessionId}/
│   ├── clarify.json       # 阶段输出
│   ├── design.json
│   ├── dev.json
│   └── checkpoint.json    # 检查点
└── logs/                  # 本地日志
```

### 控制面视角（通过 API）

```typescript
// 不再直接读文件
// const content = await readFile(join(projectDir, `run-${id}`, `${stage}.json`))

// 改为 API 调用
const response = await fetch(`https://agent:8443/output/${stage}?sessionId=${id}`)
const { status, output } = await response.json()
```

## 与现有架构对比

| 特性 | 当前架构 | 控制/数据分离 |
|------|----------|--------------|
| OpenCode 位置 | 必须与 Server 同机 | 可任意位置 |
| 文件访问 | Server 本地读取 | 数据面本地读取 |
| 连接模型 | 进程间通信 | HTTP 短连接 + 回调 |
| 扩展性 | 垂直扩展 | 水平扩展（多数据面） |
| 安全边界 | 单机 | 网络隔离 + 加密 |
| 部署复杂度 | 简单 | 中等（需配置 TLS） |

## 关键设计决策

1. **短连接优先**：控制面与数据面无长连接，简化故障恢复
2. **回调驱动**：数据面主动上报状态，控制面被动接收
3. **无共享存储**：不依赖 NFS/S3，数据面本地文件即为信源
4. **向后兼容**：本地部署时，控制面与数据面可同进程运行

## 后续文档

- [改造落地方案](./02-migration-plan.md) - 具体实施步骤
