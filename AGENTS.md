# AICoder Agent System

## Overview

AICoder is a pipeline orchestrator built on top of OpenCode.

The architecture has **three layers**:

1. **Pipeline (Backend)**: A state machine that decides which stage to run next, based on the selected mode (`simple`, `standard`, `full`). It generates a compact dispatch prompt for the main agent and advances when the main agent reports completion.
2. **Main Agent (AICoder)**: The strict dispatcher. It receives one stage at a time from the pipeline, calls the `task` tool to spawn the correct sub-agent, validates the result, saves JSON to disk, and returns `finish: "stop"`.
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
  subagent_type: "clarify"
})
```

Available `subagent_type` values: `clarify`, `design`, `task`, `dev`, `test`, `review`, `validate`.

**Never** instruct the primary agent to simply write `@clarify` in its response text — this does nothing in OpenCode's architecture.

### 2. Primary Agent Name

The primary orchestrator agent filename and agent identifier is **`AICoder`** (not `main`).

- File: `agents/AICoder.md`
- API call: `{ agent: 'AICoder' }`

### 3. Pipeline Modes

The backend pipeline supports three modes. The backend tells AICoder which mode to run, but **AICoder only sees one stage at a time**.

| Mode | Stages |
|------|--------|
| `simple` (was `fast`) | `clarify → dev` |
| `standard` | `clarify → design → dev → review` |
| `full` | `clarify → design → task → dev → test → review → validate` |

### 4. Prompt Economy (CRITICAL)

To prevent the main agent's context from exploding (which previously caused dispatch latency to grow from ~10s to >200s), the **backend must keep the dispatch prompt minimal**:

- ❌ **Do NOT** embed full previous stage outputs into the prompt
- ✅ **DO** provide file paths (e.g. `run-{sessionId}/clarify.json`) and let AICoder read them if needed
- ✅ **DO** keep the dispatch prompt under ~500 tokens

### 5. Workspace Model

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

### 6. External OpenCode Server

If the user provides an external `opencodeUrl` (e.g. `http://localhost:4096`):
- **DO NOT** spawn a local `opencode serve` process
- Connect directly via HTTP client
- Pass the same `client` instance into `executePipeline()` to avoid duplicate process creation

### 7. Pipeline Flow

1. Backend receives user requirements and selects a pipeline mode
2. Backend sends a **minimal dispatch prompt** to AICoder: "Run stage X. Context files: [list]. Output path: run-{id}/X.json"
3. AICoder calls `task` tool → launches the stage sub-agent
4. Sub-agent completes and returns result to AICoder
5. AICoder validates output, saves JSON to `run-{sessionId}/{stage}.json`
6. AICoder returns `finish: "stop"` to the backend
7. Backend advances to the next stage and repeats
8. After all stages, pipeline marks session `completed`

See `docs/` for more detailed architecture documentation.
