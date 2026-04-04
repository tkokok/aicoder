# P1 高优先级改进

> 重要但不紧急的问题，影响功能完整性、性能或开发体验

---

## 1. Git Worktree 删除导致数据丢失风险

### 问题描述
删除 session 时会递归删除整个项目目录，包括 git worktree。如果 worktree 包含未提交的更改或本地提交，这些数据将永久丢失。

**代码位置**: `server/routes.ts:503-508`

```typescript
// Clean up project directory
try {
  await rm(session.project_path, { recursive: true, force: true });
} catch (err) {
  request.log.warn({ err }, `Failed to remove project directory: ${session.project_path}`);
}
```

### 触发条件
- 用户删除 session 时 worktree 有未提交的更改
- worktree 有本地 commit 但未 push
- 其他程序正在使用该目录

### 影响
- **数据丢失**：未提交的代码永久消失
- **Git 状态混乱**：主仓库的 worktree 引用指向不存在的位置
- **用户体验差**：用户可能误以为删除的只是记录，而非实际代码

### 改进方向

```typescript
// 方案 1: 软删除 + 延迟清理
async function safeDeleteSession(sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  
  // 1. 检查 worktree 状态
  const worktreeStatus = await checkWorktreeStatus(session.workspace_path);
  
  if (worktreeStatus.hasUncommittedChanges) {
    // 选项 A: 阻止删除并提示用户
    throw new Error(
      `Workspace has uncommitted changes. ` +
      `Please commit or stash them before deleting.`
    );
    
    // 选项 B: 自动创建备份分支
    const backupBranch = `aicoder-backup-${sessionId}-${Date.now()}`;
    await createBackupBranch(session.workspace_path, backupBranch);
  }
  
  // 2. 软删除：移动目录到回收站而非强制删除
  const trashPath = join(homedir(), '.aicoder', '.trash', `${sessionId}-${Date.now()}`);
  await mkdir(dirname(trashPath), { recursive: true });
  await rename(session.project_path, trashPath);
  
  // 3. 标记 session 为已删除
  db.prepare(`UPDATE sessions SET status = 'deleted', deleted_at = ? WHERE id = ?`)
    .run(Date.now(), sessionId);
  
  // 4. 延迟清理（30天后自动删除）
  scheduleTrashCleanup(30 * 24 * 60 * 60 * 1000);
}
```

---

## 2. 外部 OpenCode 会话泄漏

### 问题描述
使用外部 OpenCode 服务器时，删除 session 只关闭本地客户端引用，远程会话仍在运行，导致资源泄漏。

**代码位置**: `server/routes.ts:490-495`

```typescript
// Shut down associated OpenCode process first
try {
  OpenCodeManager.shutdown(session.project_path);
} catch {
  // ignore shutdown errors
}
```

### 改进方向

```typescript
// 方案: 资源生命周期追踪表
interface SessionResource {
  id: string;
  session_id: string;
  resource_type: 'opencode_session' | 'process' | 'port' | 'file_lock';
  resource_id: string;
  metadata: Record<string, unknown>;
  created_at: number;
}

// 创建 session 时记录所有资源
async function createSession(input: SessionInput): Promise<string> {
  const sessionId = generateId();
  
  // 创建 OpenCode 会话
  const opencodeSession = await client.createSession({ title: input.projectName });
  
  // 记录资源
  db.prepare(`
    INSERT INTO session_resources (id, session_id, resource_type, resource_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    generateId(),
    sessionId,
    'opencode_session',
    opencodeSession.id,
    JSON.stringify({ url: opencodeUrl, is_external: isExternal }),
    Date.now()
  );
  
  return sessionId;
}

// 删除 session 时清理所有资源
async function deleteSession(sessionId: string): Promise<void> {
  const resources = db.prepare(`
    SELECT * FROM session_resources WHERE session_id = ?
  `).all(sessionId) as SessionResource[];
  
  for (const resource of resources) {
    try {
      switch (resource.resource_type) {
        case 'opencode_session':
          await cleanupOpenCodeSession(resource);
          break;
        case 'process':
          killProcess(resource.resource_id);
          break;
        case 'port':
          releasePort(parseInt(resource.resource_id));
          break;
      }
      
      // 标记为已清理
      db.prepare(`DELETE FROM session_resources WHERE id = ?`).run(resource.id);
    } catch (err) {
      logger.error({ err, resource }, 'Failed to cleanup resource');
    }
  }
}
```

---

## 3. 测试与实际代码不匹配

### 问题描述
测试用例的期望值与实际代码行为不符。

**代码位置**: `server/validation.ts:21-23` vs `server/validation.test.ts:44-46`

```typescript
// 实际代码
if (trimmed.length <= 4) {
  return "Project name must be more than 4 characters";
}

// 测试期望
expect(validateProjectName("ab")).toBe("Project name must be at least 3 characters");
```

### 改进方向
- 统一错误消息格式
- 修复测试用例或实际代码，保持一致
- 在 CI 中强制要求测试通过

---

## 4. WebSocket 和 HTTP 轮询状态冲突

### 问题描述
两个独立的数据源同时更新 UI，没有主从关系，可能导致状态不一致。

**代码位置**: `frontend/status.ts:86-97`, `186-223`

### 改进方向
```typescript
// 方案: 统一状态管理
class StateManager {
  private state: AppState = { /* ... */ };
  private ws: WebSocket | null = null;
  private pollTimer: number | null = null;
  private stateVersion = 0;  // 用于冲突解决
  
  // 统一状态更新入口
  private updateState(updater: (state: AppState) => void, source: 'ws' | 'poll'): void {
    const prevState = this.state;
    const nextState = { ...prevState };
    updater(nextState);
    
    // 简单冲突解决：版本号优先
    if (nextState.version < prevState.version) {
      console.warn('Ignoring stale state update from', source);
      return;
    }
    
    this.state = nextState;
    this.notifyListeners();
  }
  
  // WebSocket 为主，HTTP 轮询为备份
  connect(): void {
    // 1. 先启动 HTTP 轮询作为备份
    this.startPolling();
    
    // 2. 尝试 WebSocket
    this.ws = new WebSocket(WS_URL);
    
    this.ws.onopen = () => {
      // WebSocket 连接成功，停止 HTTP 轮询
      this.stopPolling();
      this.updateConnectionStatus('connected');
    };
    
    this.ws.onclose = () => {
      // WebSocket 断开，重新启动 HTTP 轮询
      this.startPolling();
      this.scheduleReconnect();
    };
  }
}
```

---

## 5. Pipeline 模板化（来自 roadmap Phase 2.1）

### 现状
Pipeline 7 个 stage 完全硬编码，所有项目都必须走完整流程。

### 改进方向

```typescript
// 模板定义
interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  stages: PipelineStage[];
  gates?: PipelineStage[];  // 需要人工审批的 stage
  parallelizable?: PipelineStage[][];  // 可并行执行的 stage 组
}

// 预定义模板
const BUILT_IN_TEMPLATES: PipelineTemplate[] = [
  {
    id: 'minimal',
    name: 'Minimal',
    description: '轻量级：需求澄清 → 开发 → 代码审查',
    stages: ['clarify', 'dev', 'review'],
  },
  {
    id: 'backend-api',
    name: 'Backend API',
    description: '完整后端：包含设计、测试和验证',
    stages: ['clarify', 'design', 'task', 'dev', 'test', 'review', 'validate'],
    gates: ['design', 'dev'],
  },
  {
    id: 'frontend-only',
    name: 'Frontend Only',
    description: '前端项目：设计 → 开发 → 审查',
    stages: ['clarify', 'design', 'dev', 'review'],
  },
  {
    id: 'spec-driven',
    name: 'Spec Driven',
    description: '基于已有规格：任务分解 → 开发 → 测试 → 验证',
    stages: ['task', 'dev', 'test', 'validate'],
  },
];

// 动态 pipeline 构建
function buildPipeline(template: PipelineTemplate, config: UserConfig): Pipeline {
  const stages = template.stages.map(stageId => {
    const stageConfig = config.stageConfigs?.[stageId] || {};
    return {
      id: stageId,
      agent: stageConfig.agent || getDefaultAgent(stageId),
      model: stageConfig.model || config.defaultModel,
      timeout: stageConfig.timeout || getDefaultTimeout(stageId),
      retryPolicy: stageConfig.retryPolicy || { maxRetries: 2 },
    };
  });
  
  return {
    id: generateId(),
    template: template.id,
    stages,
    gates: template.gates || [],
    createdAt: Date.now(),
  };
}
```

---

## 6. 模型路由（来自 roadmap Phase 4.1）

### 现状
整个 Pipeline 使用单一模型，无法针对不同 stage 的特点优化。

### 改进方向

```typescript
interface ModelRoutingConfig {
  defaultModel: string;
  stageModels: Partial<Record<PipelineStage, string>>;
  fallbackStrategy: 'default' | 'retry' | 'abort';
}

// 不同 stage 的最优模型选择
const STAGE_MODEL_RECOMMENDATIONS: Record<PipelineStage, string[]> = {
  // 需要强推理能力
  clarify: ['anthropic/claude-opus-4', 'openai/o3-mini', 'deepseek-r1'],
  design: ['anthropic/claude-opus-4', 'openai/o1-mini', 'kimi/k1.5'],
  
  // 需要代码能力
  task: ['kimi/k2.5', 'anthropic/claude-sonnet-4', 'openai/gpt-4o'],
  dev: ['kimi/k2.5', 'deepseek-v3', 'anthropic/claude-sonnet-4'],
  
  // 需要快速执行
  test: ['kimi/k2.5', 'openai/gpt-4o-mini', 'anthropic/claude-haiku'],
  review: ['anthropic/claude-opus-4', 'kimi/k2.5', 'openai/o1-mini'],
  validate: ['openai/gpt-4o', 'kimi/k2.5'],
};

// 成本感知的路由
interface CostBudget {
  maxTotalCost: number;      // 整个 pipeline 最大费用
  maxStageCost: number;      // 单个 stage 最大费用
  warningThreshold: number;    // 警告阈值（如 80%）
}

async function routeToModel(
  stage: PipelineStage,
  prompt: PromptPart[],
  config: ModelRoutingConfig,
  budget: CostBudget
): Promise<ModelResponse> {
  const modelId = config.stageModels[stage] || config.defaultModel;
  const estimatedCost = estimateCost(modelId, prompt);
  
  // 检查预算
  if (estimatedCost > budget.maxStageCost) {
    // 降级到更便宜的模型
    const cheaperModel = findCheaperAlternative(modelId, stage);
    logger.warn({ 
      originalModel: modelId, 
      cheaperModel,
      estimatedCost 
    }, 'Downgrading model due to cost');
    return callModel(cheaperModel, prompt);
  }
  
  return callModel(modelId, prompt);
}
```

---

## 7. Human-in-the-Loop（来自 roadmap Phase 2.2）

### 现状
Pipeline 完全自动运行，无法在某 stage 暂停等待人工确认。

### 改进方向

```typescript
interface HITLConfig {
  gates: PipelineStage[];  // 需要人工审批的 stage
  timeoutMs: number;       // 审批超时时间
  defaultAction: 'approve' | 'reject' | 'pause';
  notifications: {
    webhook?: string;
    email?: string;
    slack?: string;
  };
}

// 审批状态机
type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout' | 'cancelled';

interface ApprovalRequest {
  id: string;
  session_id: string;
  stage: PipelineStage;
  status: ApprovalStatus;
  request_data: {
    design_doc?: string;      // design stage 产出
    implementation_plan?: string;  // dev stage 产出
    test_results?: string;    // test stage 产出
  };
  requested_at: number;
  responded_at?: number;
  responded_by?: string;
  comment?: string;
}

// Pipeline 集成
async function executePipelineWithHITL(
  pipeline: Pipeline,
  hitlConfig: HITLConfig
): Promise<PipelineResult> {
  for (const stage of pipeline.stages) {
    // 检查是否是 gate stage
    if (hitlConfig.gates.includes(stage.id)) {
      // 执行 stage 但不提交，等待审批
      const previewResult = await executeStageForPreview(stage);
      
      // 创建审批请求
      const approval = await createApprovalRequest({
        session_id: pipeline.sessionId,
        stage: stage.id,
        request_data: previewResult
      });
      
      // 发送通知
      await notifyApprovalRequested(hitlConfig.notifications, approval);
      
      // 等待审批（轮询或 WebSocket）
      const response = await waitForApproval(approval.id, hitlConfig.timeoutMs);
      
      if (response.status !== 'approved') {
        throw new PipelineError(
          `Stage ${stage.id} not approved: ${response.comment || response.status}`,
          { stage: stage.id, approval }
        );
      }
      
      // 审批通过，正式提交
      await commitStageExecution(stage, previewResult);
    } else {
      // 普通 stage，直接执行
      await executeStage(stage);
    }
  }
}

// 前端审批界面
interface ApprovalUI {
  // 展示 stage 产出
  renderDesignDoc(doc: string): void;
  renderImplementationPlan(plan: string): void;
  renderTestResults(results: string): void;
  
  // 审批操作
  approve(comment?: string): void;
  reject(comment: string): void;
  requestChanges(changes: string): void;
}
```

---

## 8. 结构化日志与可观测性

### 现状
使用 `console.log` 输出日志，没有结构化，难以聚合和分析。

### 改进方向

```typescript
// 结构化日志配置
import { pino } from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      host: bindings.hostname,
    }),
  },
  base: {
    service: 'aicoder',
    version: process.env.npm_package_version,
  },
  redact: {
    paths: ['*.password', '*.token', '*.secret', '*.authorization'],
    remove: true,
  },
});

// 请求上下文追踪
interface RequestContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sessionId?: string;
  userId?: string;
}

// 为每个请求创建 child logger
function createRequestLogger(context: RequestContext) {
  return logger.child({
    trace_id: context.traceId,
    span_id: context.spanId,
    parent_span_id: context.parentSpanId,
    session_id: context.sessionId,
    user_id: context.userId,
  });
}

// Pipeline 阶段追踪
async function executeStage(
  stage: PipelineStage,
  context: RequestContext,
  input: unknown
): Promise<StageResult> {
  const stageLogger = createRequestLogger(context).child({ stage });
  
  const span = createSpan('pipeline.stage', {
    'stage.name': stage,
    'session.id': context.sessionId,
  });
  
  stageLogger.info({ input }, 'Stage execution started');
  const startTime = Date.now();
  
  try {
    const result = await runStageAgent(stage, input);
    
    const duration = Date.now() - startTime;
    stageLogger.info({
      duration_ms: duration,
      status: result.status,
    }, 'Stage execution completed');
    
    span.setAttributes({
      'stage.duration_ms': duration,
      'stage.status': result.status,
    });
    span.end();
    
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    stageLogger.error({
      err: error,
      duration_ms: duration,
    }, 'Stage execution failed');
    
    span.recordException(error as Error);
    span.setAttributes({ 'stage.status': 'failed' });
    span.end();
    
    throw error;
  }
}

// 成本追踪
interface CostMetrics {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  total_tokens: number;
  estimated_cost_usd: number;
  model: string;
  provider: string;
}

function recordCostMetrics(
  context: RequestContext,
  stage: PipelineStage,
  metrics: CostMetrics
): void {
  const costLogger = createRequestLogger(context).child({
    stage,
    cost_category: 'llm_usage',
  });
  
  costLogger.info({
    input_tokens: metrics.input_tokens,
    output_tokens: metrics.output_tokens,
    reasoning_tokens: metrics.reasoning_tokens,
    total_tokens: metrics.total_tokens,
    estimated_cost_usd: metrics.estimated_cost_usd,
    model: metrics.model,
    provider: metrics.provider,
  }, 'Cost metrics recorded');
  
  // 存储到数据库用于分析
  db.prepare(`
    INSERT INTO cost_metrics (
      session_id, stage, input_tokens, output_tokens, 
      total_tokens, cost_usd, model, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    context.sessionId,
    stage,
    metrics.input_tokens,
    metrics.output_tokens,
    metrics.total_tokens,
    metrics.estimated_cost_usd,
    metrics.model,
    Date.now()
  );
}
```

---

## 9. CI/CD 原生集成（来自 roadmap Phase 3.1）

### 现状
Test 和 Validate 阶段通过 sub-agent 运行，而非真实 CI 环境。

### 改进方向

```typescript
// GitHub Actions 集成
interface GitHubCIConfig {
  workflow: string;           // 要触发的工作流文件
  ref?: string;               // 分支或 commit
  inputs?: Record<string, string>;  // 工作流输入
  timeoutMinutes: number;
  pollIntervalMs: number;
}

async function runTestsInCI(
  sessionId: string,
  workspacePath: string,
  config: GitHubCIConfig
): Promise<CITestResult> {
  // 1. 创建临时分支
  const branchName = `aicoder/${sessionId}`;
  await createBranch(workspacePath, branchName);
  await commitAll(workspacePath, 'AICoder generated changes');
  await pushBranch(workspacePath, branchName);
  
  // 2. 触发 GitHub Actions 工作流
  const runId = await triggerWorkflow({
    owner: config.repoOwner,
    repo: config.repoName,
    workflow_id: config.workflow,
    ref: branchName,
    inputs: {
      ...config.inputs,
      aicoder_session_id: sessionId,
    },
  });
  
  // 3. 轮询等待结果
  const result = await pollWorkflowResult({
    owner: config.repoOwner,
    repo: config.repoName,
    run_id: runId,
    timeoutMs: config.timeoutMinutes * 60 * 1000,
    pollIntervalMs: config.pollIntervalMs,
  });
  
  // 4. 拉取并解析测试结果
  const testOutput = await downloadArtifact({
    owner: config.repoOwner,
    repo: config.repoName,
    run_id: runId,
    artifact_name: 'test-results',
  });
  
  return {
    success: result.conclusion === 'success',
    durationMs: result.durationMs,
    testCount: testOutput.total,
    passed: testOutput.passed,
    failed: testOutput.failed,
    skipped: testOutput.skipped,
    details: testOutput.details,
  };
}
```

---

## 总结

| 优先级 | 问题 | 风险等级 | 预计工作量 |
|-------|------|---------|-----------|
| P1 | Git Worktree 删除 | 🟠 高 | 2 天 |
| P1 | OpenCode 会话泄漏 | 🟠 高 | 1 天 |
| P1 | Session 并发 | 🔴 极高 | 2 天 |
| P1 | WebSocket/HTTP 冲突 | 🟠 高 | 2 天 |
| P1 | 测试不匹配 | 🟡 中 | 0.5 天 |
| P1 | 结构化日志 | 🟡 中 | 3 天 |
| P1 | Pipeline 模板化 | 🟠 高 | 5 天 |
| P1 | 模型路由 | 🟠 高 | 3 天 |
| P1 | CI/CD 集成 | 🟠 高 | 5 天 |

**建议执行顺序**:
1. 先完成 P0 的所有修复
2. 然后并行进行 P1 的数据安全（Worktree、会话泄漏）和架构改进（模板化、模型路由）
3. 最后实现 CI/CD 集成和可观测性
