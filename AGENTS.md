# AICoder Agent System

## Overview

AICoder is a pipeline orchestrator built on top of OpenCode.

The current architecture is **Plan B (One-Shot Authorization)** with a **Local / Remote mode** split:

- **Remote mode (default)**: Control plane (`:8080`) + Data plane (`:2080`).
  The control plane manages sessions, agents, and the UI. The data plane runs pipelines by talking directly to OpenCode and reports progress back via authenticated HTTP callbacks.
- **Local mode (`USE_DATA_PLANE=false`)**: Legacy single-process server that handles everything directly.

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

### 7. Local vs Remote Mode

| | Remote (default) | Local (`USE_DATA_PLANE=false`) |
|---|---|---|
| Architecture | Control Plane (`:8080`) + Data Plane (`:2080`) | Single monolithic server (`:8080`) |
| Agent Config | Managed via `agents.html` UI, stored in `agents` table | Hardcoded external OpenCode URL in advanced options |
| OpenCode Connection | Data plane connects directly to `opencode_local_url` | Server connects directly to configured OpenCode URL |
| Frontend Create Form | Shows **Agent selector** | Shows **Advanced Options** (URL / headers / auth) |
| Progress Callbacks | HTTP callbacks from data plane → control plane | In-memory broadcast |

Remote mode environment example:
```bash
MODE=local CALLBACK_TOKEN=test-token bun dist/server/index.js
```

In Remote mode, `DEFAULT_AGENT_URL` auto-points to the bundled data plane (`http://localhost:2080`). In Local mode, it uses whatever OpenCode URL the user configures.

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
  - `create.html` — Project creation form (adapts Local/Remote)
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
