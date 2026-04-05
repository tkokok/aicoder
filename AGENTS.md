# AICoder Agent System

## Overview

AICoder is a pipeline orchestrator built on top of OpenCode.

The current architecture is **Plan B (One-Shot Authorization)**:

1. **Pipeline (Backend)**: Generates a single comprehensive playbook containing all stage prompts, execution rules, and file paths. It sends this playbook once to the AICoder main agent, then enters a **filesystem polling loop** to track progress by reading `run-{sessionId}/{stage}.json` files.
2. **Main Agent (AICoder)**: Receives the full playbook at once. It autonomously iterates through stages, calls the `task` tool for each sub-agent, validates results, saves JSON outputs to disk, and emits visible progress text.
3. **Sub-Agents (`clarify`, `design`, `task`, `dev`, `test`, `review`, `validate`)**: Specialists that perform the actual work for their stage.

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

After dispatching the playbook, the backend **does not interact with AICoder again** until completion. Progress is tracked entirely by polling:

- **Interval**: every 3 seconds
- **Source of truth**: `run-{sessionId}/{stage}.json` files on disk
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

### 7. External OpenCode Server

If the user provides an external `opencodeUrl` (e.g. `http://127.0.0.1:4096`):
- **DO NOT** spawn a local `opencode serve` process
- Connect directly via HTTP client
- Pass the same `client` instance into `executePipeline()` to avoid duplicate process creation

**Random mode** spawns a temporary local OpenCode server on a random port (20000-30000).

### 8. Agent Frontmatter Injection

At session creation time, the backend injects two frontmatter fields into **all** agent files (`AICoder.md` + every sub-agent):

```yaml
model: <selected-model>
reasoning_effort: <low|medium|high>
```

Default: `low`. This is configurable via the "Reasoning Level" dropdown on the create page.

### 9. Frontend / Build

- **Build**: `npm run build` runs `tsc && cp frontend/*.html frontend/*.css dist/frontend/`
- **Server entry**: `bun dist/server/index.js` (port 8080)
- **Frontend pages**:
  - `index.html` — Session list (compact table layout)
  - `create.html` — Project creation form
  - `status.html` — Real-time pipeline status (table + 2-column grid)
  - `report.html` — Session report with markdown rendering
- **Design system**: Dark theme (`#0b0c0f` background), compact table-based layouts, desktop-first

### 10. Pipeline Flow (Plan B)

1. Backend receives user requirements and selects a pipeline mode
2. Backend generates the **full playbook** and sends it **once** to AICoder via `sendMessage`
3. AICoder autonomously loops through stages:
   - Emit visible text: `🚀 Starting stage {i}/{n}: {stage}`
   - Call `task` tool with correct subagent_type
   - Wait for result
   - Validate and save JSON to `run-{sessionId}/{stage}.json`
   - Emit visible text: `✅ Stage {stage} completed.`
4. After all stages, AICoder returns `{ "finish": "stop", "status": "completed" }`
5. Backend detects completion via filesystem polling and marks session `completed`

See `docs/` for more detailed architecture documentation.
