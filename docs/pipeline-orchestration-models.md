# Pipeline Orchestration Models

> Two architectural patterns for how the backend coordinates pipeline stages with the AICoder main agent.

---

## Plan A: Stage-by-Stage Dispatch

### Overview

The backend acts as an explicit state machine. For each stage:

1. Backend constructs a compact **dispatch prompt** for the current stage only
2. Backend sends it to the AICoder main agent session (`opencodeSessionId`) via `sendMessage`
3. AICoder reads the prompt, calls the `task` tool with the correct `subagent_type`
4. Subagent executes inside the nested `task` block
5. AICoder validates the result, saves JSON to disk, returns `finish: "stop"`
6. Backend polls the session, detects completion, and advances to the next stage
7. Repeat until all stages are done

### Message Flow (OpenCode UI)

```
[User]  backend: "=== CURRENT STAGE: clarify === ..."
[Assistant] AICoder: calls task({ subagent_type: "clarify", ... })
    └── [Nested Task Block] clarify subagent runs
[Assistant] AICoder: saves JSON, returns { finish: "stop", stage: "clarify", status: "completed" }

[User]  backend: "=== CURRENT STAGE: design === ..."
[Assistant] AICoder: calls task({ subagent_type: "design", ... })
    └── [Nested Task Block] design subagent runs
[Assistant] AICoder: saves JSON, returns { finish: "stop", ... }

... (repeat for each stage)
```

### Pros

- **Tight control**: Backend can inject stage-specific context, retry logic, and checkpoints precisely
- **Interruptible**: Easy to pause, resume, or fail-fast between stages because the backend decides when to proceed
- **Checkpoint-friendly**: `checkpoint.json` is saved after every stage; resuming is straightforward
- **Prompt minimalism**: Each dispatch prompt is small (~500 tokens), preventing parent-agent context explosion

### Cons

- **Observability gap**: The backend's "user" messages look like ordinary chat input. There's no visual distinction that these are "system dispatch instructions."
- **Conversation clutter**: A 7-stage pipeline inserts 7 backend messages + 7 AICoder responses into the main thread, making the timeline long
- **Passive UI**: While a subagent is running inside `task`, the main thread appears idle. Users must expand the `task` block to see what's happening
- **Progress not self-describing**: OpenCode sidebar only shows the session title; it does not show "Running stage 3/7" unless the user scrolls through messages

---

## Plan B: One-Shot Pipeline Authorization

### Overview

The backend sends **exactly one** comprehensive prompt at the start of the pipeline:

1. Backend constructs a full **pipeline playbook** containing:
   - The complete stage sequence (`simple` / `standard` / `full`)
   - Per-stage `subagent_type` mapping
   - Output paths for JSON files
   - Global validation rules and retry policy
2. Backend sends this once to the AICoder main agent
3. AICoder autonomously iterates through all stages:
   - For each stage, it calls `task` with the appropriate `subagent_type`
   - Waits for the tool result
   - Saves JSON
   - Optionally emits a self-message like "Stage X completed, moving to Y"
   - Proceeds to the next stage
4. Backend does **not** send any further messages. It only:
   - Polls the filesystem (`run-{id}/checkpoint.json`, `status.yaml`, stage JSONs)
   - Broadcasts progress to the web UI via SSE / WebSocket

### Message Flow (OpenCode UI)

```
[User]  backend: "=== PIPELINE PLAYBOOK ===\nMode: standard\nStages: clarify → design → dev → review\n..."
[Assistant] AICoder: "Starting pipeline stage 1/4: clarify"
[Assistant] AICoder: calls task({ subagent_type: "clarify", ... })
    └── [Nested Task Block] clarify subagent runs
[Assistant] AICoder: saves JSON, self-reports: "clarify completed. Next: design"
[Assistant] AICoder: calls task({ subagent_type: "design", ... })
    └── [Nested Task Block] design subagent runs
... (AICoder drives the rest autonomously)
```

### Pros

- **Maximum observability in OpenCode UI**: The entire pipeline execution is one continuous AICoder conversation. Users see a coherent narrative: "Starting X → task → completed → Starting Y"
- **No backend chatter**: No repeated "user" messages interrupting the flow
- **True agent autonomy**: AICoder behaves like a real orchestrator; the backend is just an infrastructure shell
- **Simpler backend logic**: No stage loop, no per-stage dispatch prompts, no checkpoint-driven resume inside the loop

### Cons

- **Larger initial prompt**: The playbook must contain rules for all stages, increasing the first-turn token count
- **Harder to interrupt/resume**: If the pipeline fails at stage 5, resuming requires AICoder to re-read all previous JSON outputs and figure out where to continue. The backend has less control to "push" it to the right stage
- **Context drift risk**: After 7 stages of nested `task` results, AICoder's own context may grow large, potentially degrading performance or causing it to lose track of the playbook rules
- **Debugging harder**: If AICoder skips a stage or calls the wrong subagent, the backend cannot easily inject a corrective message without breaking the "one-shot" model

---

## Comparison Matrix

| Concern | Plan A (Stage-by-Stage) | Plan B (One-Shot) |
|---------|--------------------------|--------------------|
| **Backend control** | High | Low |
| **Checkpoint / resume** | Easy | Harder |
| **OpenCode UI clutter** | More backend messages | Clean, single thread |
| **Nested task visibility** | Good (same as B) | Good |
| **Progress discoverability** | Poor (must scroll) | Good (self-narrated) |
| **Initial prompt size** | Small | Large |
| **Context growth** | Controlled per stage | Grows with all stages |
| **Failure recovery** | Backend retry loop | AICoder must self-recover |

---

## Where We Are Today

The current codebase implements **Plan B**. The backend file `server/pipeline.ts` sends a single comprehensive playbook at pipeline start and then polls the filesystem for progress. The `server/prompts/pipeline-dispatch.ts` module generates the full playbook, and `agents/AICoder.md` instructs the main agent to autonomously execute all stages in sequence.

The documented observability limitations of Plan A are the primary reason Plan B was adopted.
