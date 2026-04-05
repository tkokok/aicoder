# Subagent Orchestration Refactor Plan

> Date: 2026-04-04  
> Goal: Decouple pipeline orchestration from the parent agent by making the backend directly poll subagent sessions.

---

## 1. Problem Statement

Currently, the backend sends a monolithic stage prompt to the **parent agent**, which then:
1. Calls `task()` to spawn a subagent.
2. Waits for the subagent to finish.
3. Validates the output.
4. Writes the result as JSON to disk.
5. Returns `finish=stop`.

This couples pipeline logic with the parent agent’s reasoning chain. The backend is "half-blind" to subagent progress and must wait for the parent agent’s secondary actions (e.g., `write`), which are error-prone and slow.

**Example symptom:** In `stage-machine-test-v3`, the `clarify` subagent finished quickly, but the parent agent failed `write` twice (empty `filePath`) before succeeding, causing 3 retries and long wait times.

---

## 2. Design Principle

**"Parent agent as stateless dispatcher, backend as the sole orchestrator."**

- The parent agent’s only job is to **start the subagent** and **return its `subagent_session_id`**.
- The backend then **directly polls the subagent session** until it completes.
- The subagent is responsible for **writing its own output JSON** to a predetermined path.
- The backend reads the JSON, updates `status.yaml`, and advances to the next stage.

---

## 3. Detailed Changes

### 3.1 `server/pipeline.ts`

#### A. Split prompt builder into two functions

Replace `buildStagePrompt()` with two functions:

1. **`buildDispatchPrompt(...)`** — Ultra-short prompt for the parent agent.
   - Instructs it to call `task(subagent_type="${stage}", description=..., prompt=...)`.
   - The `prompt` argument passed to `task` must contain the full subagent instructions.
   - After `task` returns, extract `subagent_session_id` and return:
     ```json
     { "finish": "stop", "subagent_session_id": "<id>" }
     ```

2. **`buildSubagentPrompt(...)`** — Full instructions for the subagent.
   - Includes user requirements, previous stage outputs, workspace path, and **output requirements**.
   - Ends with an explicit instruction:
     ```
     When you finish, save the result as JSON to:
     ${projectDir}/run-${sessionId}/${stage}.json
     The JSON MUST contain:
     {
       "status": "completed" | "failed",
       "output": <stage-specific result>,
       "error": "<string if failed>"
     }
     Then return finish=stop.
     ```

#### B. Add `pollSubagentSession()`

New function, similar to `pollForResponse()`, but polls **the child session**:

```ts
async function pollSubagentSession(
  client: OpenCodeClient,
  subagentSessionId: string,
  maxAttempts = 600,
  pollIntervalMs = 5000
): Promise<Record<string, unknown>>
```

- Fetches messages from `subagentSessionId`.
- Looks for the latest assistant message with `finish === 'stop'`.
- Returns the extracted JSON from that message (or raw text if no JSON).
- Throws `Timeout` if `maxAttempts` exceeded.

#### C. Rewrite `executePipeline()` stage loop

Current pseudo-code:
```ts
for stage in STAGE_ORDER:
  sendPrompt(buildStagePrompt(...))   // parent does everything
  pollForResponse(...)                // wait for parent stop
  readStageOutput(...)                // read file
```

New pseudo-code:
```ts
for stage in STAGE_ORDER:
  // 1. Dispatch
  sendPrompt(buildDispatchPrompt(...))
  dispatchResult = pollForResponse(...)
  subagentSessionId = dispatchResult.subagent_session_id

  // 2. Wait for subagent directly
  await pollSubagentSession(client, subagentSessionId)

  // 3. Read output (primary: disk; fallback: last subagent message)
  let savedOutput = await readStageOutput(sessionId, stage, projectDir)
  if (!savedOutput) {
    savedOutput = await extractOutputFromSubagentSession(client, subagentSessionId)
    if (savedOutput) {
      await writeFile(stagePath, JSON.stringify(savedOutput, null, 2))
    }
  }

  // 4. Update status and continue
  stageResult = { status: savedOutput?.status || 'failed', ... }
  writeStatusFile(...)
```

#### D. Fallback: `extractOutputFromSubagentSession()`

If the subagent disobeyed the instruction and did not write the JSON file, the backend will:
1. Fetch the last assistant message from the subagent session.
2. Extract the last JSON blob (or the entire text if no JSON).
3. Wrap it into `{ status: "completed", output: <extracted> }`.
4. Write it to the expected path.

This ensures resilience against subagent misbehavior.

### 3.2 `server/routes.ts` — no functional change needed

The progress polling (`startProgressPolling`) already reads from `status.yaml`, which will continue to be updated authoritatively by `executePipeline()`. No change required.

### 3.3 `server/index.ts` — already done

The orphaned-session cleanup on startup was already added in a previous commit. No further change.

---

## 4. Step-by-Step Execution Checklist

1. **Write this plan file** ✅
2. **Modify `server/pipeline.ts`**
   - Delete old `buildStagePrompt()`.
   - Implement `buildDispatchPrompt()` and `buildSubagentPrompt()`.
   - Implement `pollSubagentSession()` and `extractOutputFromSubagentSession()`.
   - Rewrite `executePipeline()` loop.
3. **Build project** (`npm run build`).
4. **Clean test state**
   - Delete `./aicoder.db`.
   - Delete `~/.aicoder/projects/` test directories.
5. **Restart server** (`bun dist/server/index.js`).
6. **Run E2E test**
   - POST `/api/sessions` with a simple todo-list requirement.
   - Poll `/api/sessions/:id` until `status=completed`.
   - Assert all 7 stages are `completed`.
   - Verify `workspace/index.html` exists and contains the expected content.
7. **Iterate and fix** if any stage fails or times out.

---

## 5. Testing Criteria

| Check | Expected |
|-------|----------|
| Session creates successfully | 201 + session id |
| `clarify` completes | `clarify.json` exists, status=completed |
| `design` completes | `design.json` exists |
| `task` completes | `task.json` exists |
| `dev` completes | `dev.json` exists + `workspace/index.html` created |
| `test` completes | `test.json` exists |
| `review` completes | `review.json` exists |
| `validate` completes | `validate.json` exists |
| Final session status | `completed` within ~5 minutes |
| No orphaned `running` states | Server logs show no stuck sessions |

---

## 6. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Parent agent fails to return `subagent_session_id` | Fallback: parse the parent session’s `task` tool part `state.output` for the task_id. |
| Subagent does not write JSON file | Fallback: backend extracts output from subagent’s last message and writes it. |
| Subagent session hangs or runs forever | `pollSubagentSession` has a timeout; after timeout, stage is marked `failed` and retried. |
| `task` tool itself errors out | Existing retry logic in `sendPromptWithRetry` still applies. |
| OpenCode native `task` blocks parent, but we need parent to stop quickly | The parent prompt is intentionally minimal; it calls `task` and immediately returns stop. Native `task` will block the parent **inside** its own tool execution, but once the subagent finishes, the parent has almost zero follow-up work. |

---

## 7. Success Metric

A full pipeline run (clarify → validate) completes in **under 3 minutes** for a simple todo-list requirement, with **zero parent-agent write failures** causing retries.
