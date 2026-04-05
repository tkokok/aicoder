# Pipeline Prompt Module Redesign — Implementation Plan

> Goal: Transition from backend-driven subagent creation to a pipeline-as-prompt-module model, where the pipeline is an independent orchestrator that converts stage sequences into compact dispatch prompts for AICoder, which then uses the native `task` tool to invoke subagents.

---

## 1. Pipeline Module Refactor

### 1.1 Remove backend-direct subagent creation
- [x] Remove `pollSubagentSession()` from `server/pipeline.ts` (no longer needed)
- [x] Remove direct `client.createSession()` + `client.sendMessage()` + `client.archiveSession()` calls for subagents
- [x] Remove `buildSubagentPrompt()` (this responsibility moves to the prompt generator module)

### 1.2 Introduce Pipeline State Machine
- [x] Define `PipelineState` interface:
  - `mode: 'simple' | 'standard' | 'full'`
  - `currentStageIndex: number`
  - `stages: string[]` (computed from `STAGE_ORDERS[mode]`)
  - `results: Record<string, { status: 'pending' | 'running' | 'completed' | 'failed'; attempts: number }>`
  - `checkpointPath: string`
- [x] After every stage completion (or failure), serialize state to `checkpoint.json`
- [x] On pipeline restart, load `checkpoint.json` and resume from `currentStageIndex`

### 1.3 Rename modes for consistency
- [x] Rename `fast` → `simple` across backend, frontend, and DB
- [x] Update frontend radio labels and validation schema

---

## 2. Prompt Generator Module (`server/prompts/pipeline-dispatch.ts`)

### 2.1 Create module
- [x] Create `server/prompts/` directory
- [x] Create `server/prompts/pipeline-dispatch.ts`

### 2.2 Implement `buildDispatchPrompt(state, config)`
Input:
- `state`: `PipelineState`
- `config`: project metadata, paths, optional auth

Output:
- A compact prompt string for AICoder

Requirements:
- Include only:
  1. Current stage name
  2. Subagent type to call via `task` tool
  3. Output JSON path: `{projectDir}/run-{sessionId}/{stage}.json`
  4. **File paths** to previous stage outputs (NOT their full contents)
  5. A short 1-paragraph task summary for the subagent (dynamic based on mode)
- Must explicitly remind AICoder to:
  - Call exactly ONE `task` tool
  - Wait for the result
  - Validate using the stage checklist
  - Save JSON to the specified path
  - Return `finish: "stop"`

### 2.3 Implement per-stage task summaries
- [x] `clarify`: summarize user requirements and expected output format
- [x] `design`: reference `clarify.json`, ask for tech stack and architecture
- [x] `task`: reference `design.json`, ask for concrete implementation tasks
- [x] `dev`: reference `task.json`, ask to implement the tasks
- [x] `test`: reference `dev.json`, ask to write/run tests
- [x] `review`: reference `dev.json` and `test.json`, ask for code review
- [x] `validate`: reference all previous outputs, ask for final validation

---

## 3. AICoder Agent Prompt Update (`agents/AICoder.md`)

### 3.1 Refocus AICoder as a pure dispatcher
- [x] Update `agents/AICoder.md` to:
  - Emphasize that AICoder **reads context from disk** when needed instead of receiving it inline
  - Provide examples of `bash` tool usage to read previous JSON outputs
  - Keep the hard constraints (no doing the work itself)

### 3.2 Fix model selection hint
- [x] Remove hardcoded `model: anthropic/claude-sonnet-4-20250514` from frontmatter or make it consistent with server config (`zhipuai-coding-plan/glm-4.7-flashx`)
- [ ] Investigate why external OpenCode sometimes selects `opencode/big-pickle` despite backend specifying a model

---

## 4. OpenCode Session Strategy

### 4.1 Parent session per pipeline
- [ ] Backend creates ONE OpenCode session for the entire pipeline
- [ ] Session title: `{projectName} — {mode} pipeline`
- [ ] Backend reuses this session for every stage dispatch

### 4.2 Context growth mitigation
- [ ] If dispatch latency exceeds a threshold (e.g. 30s), implement session compaction:
  - Option: call OpenCode `PATCH /session/{id}` to set a summary and truncate history
  - Option: fork the session for the next dispatch
- [ ] Start with simple reuse; add compaction only if latency degrades again

---

## 5. Frontend & API Updates

### 5.1 Mode rename
- [x] `frontend/create.html`: change "Fast" radio to "Simple"
- [x] `frontend/create.ts`: update form serialization
- [x] `server/routes.ts`: update `CreateSessionBody` validation (`pipelineMode` enum)

### 5.2 Status page improvements
- [ ] Display `checkpoint.json` driven progress instead of backend polling a separate DB field
- [ ] Show which stage is currently running in real time

---

## 6. Validation & Testing

### 6.1 Unit tests for prompt generator
- [ ] Test `buildDispatchPrompt` outputs for each mode
- [ ] Assert that previous stage content is NOT embedded inline
- [ ] Assert that output paths are correctly formatted

### 6.2 End-to-end pipeline tests
- [ ] Run `simple` mode end-to-end (clarify → dev)
- [ ] Run `standard` mode end-to-end
- [ ] Run `full` mode end-to-end
- [ ] Measure per-stage dispatch latency and ensure it stays < 30s
- [ ] Verify subagents appear as nested `task` blocks in the OpenCode UI

### 6.3 Resume test
- [ ] Kill the backend mid-pipeline
- [ ] Restart and verify it resumes from `checkpoint.json`

---

## 7. Cleanup

- [x] Delete dead code paths in `server/pipeline.ts`
- [x] Update `docs/agent-orchestration.md` to reflect the new architecture
- [x] Update `docs/roadmap.md` Phase 1/2 status
- [x] Run `npm run build` (or `bun build`) to verify no TypeScript errors

---

## Open Questions

1. **Model injection bug**: Why does the external OpenCode server sometimes ignore the `model` field sent in `sendMessage` and select `opencode/big-pickle` instead? Need to test whether this happens with `task` tool calls too.
2. **Session compaction API**: Does OpenCode expose a reliable API to truncate session history without breaking the pipeline? If not, is per-stage forking viable?
3. **Retry logic**: Should retries of a failed stage reuse the same subagent session (`task_id`) or start fresh? Current `AICoder.md` allows `task_id` resume — keep this behavior.
