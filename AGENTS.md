# AICoder Agent System

## Overview

AICoder is a strict 7-stage pipeline orchestrator built on top of OpenCode.

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

### 3. Workspace Model

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

### 4. External OpenCode Server

If the user provides an external `opencodeUrl` (e.g. `http://localhost:4096`):
- **DO NOT** spawn a local `opencode serve` process
- Connect directly via HTTP client
- Pass the same `client` instance into `executePipeline()` to avoid duplicate process creation

### 5. Pipeline Flow

1. AICoder receives the user prompt
2. AICoder calls `task` tool → `clarify` sub-agent
3. AICoder validates output, saves JSON to `run-{sessionId}/clarify.json`
4. Repeat for all 7 stages in strict order
5. Return final JSON with `finish: "stop"`

See `docs/` for more detailed architecture documentation.
