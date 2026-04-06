# AICoder Agent System

## Overview

AICoder is a pipeline orchestrator built on top of OpenCode.

The current architecture is **Plan B (One-Shot Authorization)** running in **Remote mode**:

- **Remote mode**: Control plane (`:8080`) + Data plane (`:2080`).
  The control plane manages sessions, agents, and the UI. The data plane runs pipelines by talking directly to OpenCode and reports progress back via authenticated HTTP callbacks.

### Core Flow (Remote Mode)

1. **Control Plane**: Generates a single comprehensive playbook containing all stage prompts, execution rules, and file paths. It creates an OpenCode session on the selected **Agent** and forwards the playbook to the **Data Plane**.
2. **Data Plane**: Receives the playbook, connects to the local OpenCode server (`opencode_local_url`), dispatches the playbook, polls OpenCode messages, watches the filesystem for stage outputs, and reports progress back to the Control Plane via callbacks.
3. **Main Agent (AICoder)**: Receives the full playbook at once. It autonomously iterates through stages, calls the `task` tool for each sub-agent, validates results, saves JSON outputs to disk, and emits visible progress text.
4. **Sub-Agents (`clarify`, `design`, `task`, `dev`, `test`, `review`, `validate`)**: Specialists that perform the actual work for their stage.

---

## Critical Implementation Notes

### 1. Sub-Agent Invocation Mechanism

**OpenCode does NOT trigger sub-agents via `@mention` in plain text.**

The ONLY way to invoke a sub-agent is through the **`task` tool** with these exact parameters:

```js
task({
  description: "Clarify requirements",
  prompt: "Please clarify these requirements...",
  subagent_type: "clarify",
  run_in_background: false,
  load_skills: []
})
```

Available `subagent_type` values: `clarify`, `design`, `task`, `dev`, `test`, `review`, `validate`.

**Important**: `run_in_background` and `load_skills` are **required** fields for the `task` tool. Omitting them causes `Tool execution aborted` errors.

**Never** instruct the primary agent to simply write `@clarify` in its response text — this does nothing in OpenCode's architecture.

### 2. Primary Agent Name

The primary orchestrator agent filename and agent identifier is **`AICoder`** (not `main`).

- File: `agents/AICoder.md`
- API call: `{ agent: 'AICoder' }`

### 3. Pipeline Modes

The backend supports three pipeline modes. AICoder receives the full stage order in the playbook and executes them sequentially:

| Mode | Stages |
|------|--------|
| `simple` | `clarify → dev` |
| `standard` | `clarify → design → dev → review` |
| `full` | `clarify → design → task → dev → test → review → validate` |

### 4. Playbook Economy

The backend generates **one comprehensive playbook** (`server/prompts/pipeline-dispatch.ts`) that contains:

- Pipeline configuration (mode, stage order, run dir, workspace dir)
- Per-stage subagent prompts
- Execution rules (how to call `task`, how to validate, how to save JSON)
- Final return format `{ "finish": "stop", "status": "completed" }`

**Do NOT** embed full previous stage outputs into prompts. Instead, provide file paths (e.g. `run-{sessionId}/clarify.json`) and let sub-agents read them if needed.

### 5. Filesystem Polling (Plan B)

After dispatching the playbook, the data plane **does not send further prompts** to AICoder. Progress is tracked by:

- **Filesystem watcher**: `run-{sessionId}/{stage}.json` files on disk
- **Message polling**: OpenCode `/session/{id}/message` is polled every 3 seconds and forwarded to the control plane so the UI can show **Latest Activity / Activity History**
- **Checkpoint**: `run-{sessionId}/checkpoint.json` prevents stage regression
- **Status file**: `run-{sessionId}/status.yaml` is also written for UI compatibility
- **Timeout**: 10 minutes of idle progress triggers pipeline failure

### 6. Workspace Model

**New Project Mode**
- Managed project directory: `~/.aicoder/projects/{sanitized-name}/`
- Workspace (code lives here): `~/.aicoder/projects/{sanitized-name}/workspace/`
- Run outputs (pipeline JSON): `~/.aicoder/projects/{sanitized-name}/run-{sessionId}/`
- Initializes a fresh git repo in workspace

**Existing Project Mode**
- Managed project directory: `~/.aicoder/projects/{sanitized-name}/` (for agents/schemas/run outputs)
- Workspace: a **git worktree** created from the user's existing repo
- Command: `git worktree add "{projectDir}/workspace" -b aicoder-{branch}`
- This keeps the original repository untouched

### 7. Remote Mode

- **Architecture**: Control Plane (`:8080`) + Data Plane (`:2080`)
- **Agent Config**: Managed via `agents.html` UI, stored in `agents` table
- **OpenCode Connection**: Data plane connects directly to `opencode_local_url`
- **Frontend Create Form**: Shows **Agent selector**
- **Progress Callbacks**: HTTP callbacks from data plane → control plane
- **`DEFAULT_AGENT_URL`** auto-points to the bundled data plane (`http://localhost:2080`)

Startup example:
```bash
NO_PROXY=localhost,127.0.0.1 CALLBACK_TOKEN=test-token bun dist/server/index.js
```

### 8. Agent Management (Remote Mode)

- **Table**: `agents` (`id`, `name`, `agent_url`, `opencode_local_url`, `opencode_public_url`, `created_at`)
- **Page**: `agents.html` — create, edit, delete agents with dark-themed protocol-validated forms
- **Selection**: `create.html` fetches `/api/config` and shows the agent selector when `useDataPlane === true`
- **Health check**: creating/updating an agent validates `agent_url` is reachable before saving

**OpenCode URL semantics**:
- `agent_url`: Data-plane-to-control callback URL (`http://localhost:2080`)
- `opencode_local_url`: Data-plane-to-OpenCode internal URL (`http://127.0.0.1:4096`)
- `opencode_public_url`: Public-facing OpenCode URL shown in the UI (`http://127.0.0.1:4096` or a custom domain)

### 9. Agent Frontmatter Injection

At session creation time, the backend injects two frontmatter fields into **all** agent files (`AICoder.md` + every sub-agent):

```yaml
model: <selected-model>
reasoning_effort: <low|medium|high>
```

Default: `low`. This is configurable via the "Reasoning Level" dropdown on the create page.

### 10. Frontend / Build

- **Build**: `npm run build` runs `tsc && cp frontend/*.html frontend/*.css dist/frontend/`
- **Server entry**: `bun dist/server/index.js`
- **Ports**:
  - Control Plane: `8080`
  - Data Plane: `2080`
  - OpenCode: `127.0.0.1:4096`
- **Frontend pages**:
  - `index.html` — Session list (compact table layout)
  - `agents.html` — Agent management (Remote mode only)
  - `create.html` — Project creation form
  - `status.html` — Real-time pipeline status (table + 2-column grid)
  - `report.html` — Session report with markdown rendering
- **Design system**: Dark theme (`#0b0c0f` background), compact table-based layouts, desktop-first

### 11. Pipeline Flow (Remote Mode)

1. User selects an **Agent** and submits requirements on `create.html`
2. Control plane creates a session record, fetches the agent config, and sends a `POST /pipeline/start` to the data plane with:
   - `playbook`
   - `opencodeUrl` (the agent's `opencode_local_url`)
3. Data plane creates an OpenCode session, dispatches the playbook, and starts polling
4. AICoder autonomously loops through stages:
   - Emit visible text: `🚀 Starting stage {i}/{n}: {stage}`
   - Call `task` tool with correct `subagent_type`
   - Wait for result
   - Validate and save JSON to `run-{sessionId}/{stage}.json`
   - Emit visible text: `✅ Stage {stage} completed.`
5. Data plane detects filesystem changes, sends stage-complete / pipeline-status / message-update callbacks to the control plane
6. Control plane updates the database and broadcasts WebSocket events so `status.html` stays live
7. After completion, the user is redirected to `report.html`

See `docs/` for more detailed architecture documentation.

### 12. Service Operations

#### Build & Deploy
- 修改任何 `server/**/*.ts` 或 `frontend/**/*.ts` 后必须执行 `npm run build` 才会生成到 `dist/`，Bun 运行的是 `dist/` 下的编译产物。

#### Startup Command
```bash
NO_PROXY=localhost,127.0.0.1 CALLBACK_TOKEN=test-token bun dist/server/index.js
```

#### Critical: `NO_PROXY` Environment Variable
- **Bun 1.3.10 只在进程启动时读取代理配置**，运行时修改 `process.env.NO_PROXY` 无效。
- 如果 shell 环境设置了 `http_proxy`，且启动时没带 `NO_PROXY=localhost,127.0.0.1`，所有 `localhost:8080` 的 data-plane → control-plane callback 会被代理拦截，导致控制面永远收不到回调（表现为 503 或请求消失）。
- 必须在启动命令里显式传入 `NO_PROXY=localhost,127.0.0.1`。

#### Automatic Reconnect on Restart
- 控制面启动 3 秒后，会自动查询 1 小时内 `status = 'running'` 的 sessions。
- 如果数据面确认 pipeline 仍在运行（OpenCode session 还活着），会调用 `/pipeline/attach` 重新挂载监控，**不会重新 dispatch playbook**。
- 如果 OpenCode session 已死，则将该 session 标记为 `failed`。

#### Background Task Timeout
- 使用 Shell 工具以 `run_in_background=true` 启动服务时，默认 10 秒超时后系统会自动发送 `SIGTERM`。
- 如需长期运行，应将 `timeout` 参数设得足够大（例如 3600 秒），或在外部终端直接启动。
