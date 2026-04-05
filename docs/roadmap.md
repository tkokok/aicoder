# AICoder Roadmap

> Positioning: **OpenCode-native + Strict stage gating + Git worktree safety + External OpenCode support**

## Phase 1: Pipeline Hardening (Current → Next 2 weeks)

### 1.1 Sub-Agent Invocation Fix
**Status**: Completed
- **Problem**: AICoder initially tried `@mention` in plain text, which OpenCode does not parse as agent routing.
- **Fix**: Migrated to a pipeline-as-prompt-module architecture. The backend generates a compact dispatch prompt; AICoder uses the `task` tool with `subagent_type` to invoke sub-agents natively.
- **Prompt economy**: Parent-agent context is kept minimal by referencing previous stage outputs via file paths instead of embedding their full contents inline.

### 1.2 Stage Recovery & Resume
**Status**: In Progress
**Motivation**: Pipelines can fail mid-way due to LLM API errors (503, rate limits) or sub-agent hallucinations.
- Save a `checkpoint.json` after every successful stage.
- On restart, read checkpoints and resume from the last completed stage.
- UI: "Resume" button on failed sessions.

### 1.3 Cost & Token Tracking
**Status**: Pending
**Motivation**: External OpenCode servers may use expensive models; users need visibility.
- Track per-stage token usage (input / output / reasoning).
- Track estimated cost per stage.
- Display in the status page and final report.

## Phase 2: Workflow Flexibility (Next 1 month)

### 2.1 Pipeline Templates
**Status**: Partially Complete
Not all projects need the full 7-stage pipeline.
- **Simple**: `clarify → dev`
- **Standard**: `clarify → design → dev → review`
- **Full**: `clarify → design → task → dev → test → review → validate`
- Future templates: Backend API, Frontend Only, Spec-Driven

Implementation:
- Stage orders are defined in `server/pipeline.ts` (`STAGE_ORDERS`).
- Frontend template selector already supports the three core modes.
- AICoder receives the stage list dynamically via the backend dispatch prompt.

### 2.2 Human-in-the-Loop (HITL) Gates
Allow users to pause the pipeline at specific stages for approval:
- Before `dev`: approve the design doc
- Before `test`: approve the implementation plan
- Configurable per template

UI:
- "Approve & Continue" / "Reject & Retry" buttons on status page
- Email / webhook notification when a gate is reached

### 2.3 Parallel Execution for Safe Stages
Some stages are independent and can run in parallel:
- `test` and `review` could run concurrently after `dev`
- Define DAG topology per template instead of a strict linear list

## Phase 3: Deep Integrations (Next 2 months)

### 3.1 CI/CD Native Validation
The `test` and `validate` stages should run in the user's actual CI environment, not just via a sub-agent.
- Trigger a GitHub Actions / GitLab CI pipeline from the workspace
- Poll CI status and feed results back to the `validate` stage
- This ensures tests run against the real target environment

### 3.2 Real Code Review Loop
The `review` stage should open a Pull Request (or a git patch) and optionally request human review.
- For existing projects: push the worktree branch to origin and open a PR
- For new projects: generate a patch file or push to a new repo
- Review agent analyzes diff + CI results

### 3.3 Diff & Visualization
- Visual diff viewer in the web UI showing what `@dev` changed
- File tree explorer for the workspace
- Before/after code comparison

## Phase 4: Scale & Extensibility (Longer term)

### 4.1 Multi-Model Routing per Stage
Different stages may benefit from different models:
- `design`: reasoning-heavy model (e.g. o3, Claude Sonnet)
- `dev`: coding-optimized model (e.g. Kimi k2p5, Gemini 2.5 Pro)
- `test`: smaller, faster model
- Allow per-stage model overrides in the template

### 4.2 Custom Agent Marketplace
- Allow users to add their own `.md` agents into `.opencode/agent/`
- UI to upload/select custom agents
- Template system references custom agents by name

### 4.3 Webhook & Scheduled Pipelines
- Webhook endpoint: `POST /api/webhooks/run-pipeline` to trigger pipelines from external events (e.g. Jira ticket created)
- Cron-based scheduled runs for maintenance tasks

### 4.4 Multi-Repo Coordination
A single feature may span multiple repositories (e.g. API + frontend + docs).
- Define a "Project Group" with multiple workspaces
- AICoder orchestrates cross-repo changes
- Each repo gets its own worktree, but the pipeline coordinates them

---

## Strategic Differentiators to Maintain

1. **OpenCode Native**: Deeply leverage OpenCode's `task` tool, multi-provider support, and local-first philosophy. Do not rebuild what OpenCode already does well.
2. **Strict Stage Gating**: The pipeline is the product. Every feature should reinforce predictability and quality control.
3. **Git Worktree Safety**: Never mutate the user's original repo directly. The worktree model is a core trust feature.
4. **External Server Friendly**: Keep supporting external OpenCode endpoints for power users who want shared model pools or centralized infra.
