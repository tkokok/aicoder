# Research Notes: OpenCode SDK & oh-my-openagent

> What AICoder can borrow from the upstream OpenCode codebase and the advanced oh-my-openagent plugin.

---

## 1. OpenCode SDK — Hidden Capabilities We Are Not Using

### 1.1 `session.status` Endpoint

**Discovery:** OpenCode exposes `GET /session/status` which returns a map of **all** session IDs to their runtime status.

```ts
// Response shape
{
  [sessionID: string]: {
    type: "idle" | "busy" | "retry"
  }
}
```

**Current AICoder gap:** We poll `GET /session/:id/message` repeatedly to guess if the agent is still working. This is expensive (downloads full message history) and brittle.

**Borrowable fix:** Replace message polling with lightweight `session.status` polling. When status flips to `idle`, *then* fetch the latest message.

---

### 1.2 `ToolPart` Message Structure

**Discovery:** Assistant messages in OpenCode are not just text. Tool results are stored as typed `ToolPart` objects inside `message.parts`:

```ts
type ToolPart = {
  type: "tool"
  callID: string
  tool: string
  state: {
    status: "completed" | "error" | "running" | "pending"
    input: Record<string, any>
    output?: string        // present when completed
    error?: string         // present when error
    title?: string
    metadata?: Record<string, any>
    time: { start: number, end?: number }
    attachments?: FilePart[]
  }
}
```

**Current AICoder gap:** We try to extract JSON by regex-parsing the raw text of assistant messages (`extractJSON`). This breaks when the model wraps output in markdown, reasoning blocks, or summary text.

**Borrowable fix:** Look for `parts.filter(p => p.type === "tool" && p.tool === "task")` and read `p.state.output` directly. This is the canonical source of truth for `task` tool results.

---

### 1.3 Session Forking (`POST /session/:id/fork`)

**Discovery:** OpenCode supports forking a session at an arbitrary message boundary, copying all prior context into a new session.

**Use case in AICoder:** If a pipeline fails at stage 5 and we want to resume, we could fork the original session *before* the failing turn, inject a "resume from stage 5" prompt, and continue. This avoids re-processing the entire playbook history.

**Borrowable fix:** Add `client.forkSession(sessionId, messageId?)` to our HTTP wrapper and use it for context-compaction-driven resume.

---

### 1.4 Context Compaction APIs (`revert`, `summarize`)

**Discovery:** OpenCode has first-class compaction:
- `POST /session/:id/revert` — restore file snapshots to a previous message point
- `POST /session/:id/summarize` — force LLM summarization of conversation history
- Internal `compaction.ts` also does **pruning** of old tool outputs (~40k token window)

**Current AICoder gap:** We originally abandoned the `task`-tool approach because parent-agent dispatch latency exploded as context grew. We solved it by switching to Plan B (one-shot playbook), but this still leaves a long conversation in the main session.

**Borrowable fix:** After every N stages, call `summarize` or fork a clean session to reset context. This would let us safely return to Plan A (stage-by-stage dispatch) without the latency penalty.

---

### 1.5 Synchronous Prompt API (`POST /session/:id/message`)

**Discovery:** OpenCode has *two* prompt endpoints:
- `prompt_async` — fire-and-forget (what we use now)
- `message` (sync) — blocks until the full assistant response is ready and returns the complete message object

**Borrowable fix:** For backend-driven subagent creation (if we ever need it again), the sync `message` endpoint removes the need for manual polling loops entirely.

---

## 2. oh-my-openagent — Prometheus / Atlas Patterns

oh-my-openagent is an OpenCode plugin that replaces the built-in agents with a multi-agent orchestration layer. Its core insight is:

> **"Human intervention is a failure signal."**

### 2.1 The Prometheus → Atlas Handoff

| Agent | Role | Output |
|-------|------|--------|
| **Prometheus** | Planner ONLY | Writes a decision-complete markdown plan to `.sisyphus/plans/{name}.md` |
| **Atlas** | Orchestrator ONLY | Reads the plan, delegates tasks, verifies results, updates checkboxes |
| **Sisyphus-Junior** | Worker | Executes individual tasks (coding, writing, etc.) |

**Key insight:** Strict separation of concerns. Prometheus is physically blocked from writing code by a `tool.execute.before` hook. Atlas is explicitly told: *"You are a conductor, not a musician."*

**For AICoder:** Our current `AICoder.md` mixes dispatching with some implicit expectations about validation. We could tighten this by splitting into:
- `AICoder` (Atlas-like orchestrator) — only delegates and verifies
- Stage subagents (Sisyphus-Junior-like workers) — only do their one job

### 2.2 Category-Based Delegation (Not Model-Name Based)

oh-my-openagent replaces `task({ agent: "gpt-5.4" })` with `task({ category: "deep" })`.

| Category | Intent | Resolved Model |
|----------|--------|----------------|
| `ultrabrain` | Complex architecture | gpt-5.4 xhigh |
| `deep` | Substantial implementation | gpt-5.4 medium |
| `quick` | Small fixes, refactors | gpt-5.4-mini |
| `visual-engineering` | UI/Pixel-perfect | gemini-3.1-pro |
| `unspecified-high` | Quality gate, review | claude-opus-4 max |

**For AICoder:** Instead of frontend dropdowns for "Main Agent Model" / "Sub-agent Model", we could expose pipeline stages as categories and let the backend resolve the cheapest/best model per stage.

### 2.3 The 4-Phase Verification Gate

Atlas enforces this after **every** `task` delegation:

1. **Automated Verification** — `bun run build`, `bun test`, LSP diagnostics
2. **Manual Code Review** — read every changed file line-by-line
3. **Hands-on QA** — Playwright, curl, interactive bash
4. **Boulder State Check** — re-read plan, count remaining checkboxes

**For AICoder:** Our current `validate` stage is a single subagent pass. We could make validation a first-class multi-subagent wave (test agent + review agent + validate agent) that runs in parallel after `dev`.

### 2.4 Boulder State (Plan Persistence)

oh-my-openagent persists orchestration state in `boulder.json`:

```json
{
  "active_plan": ".sisyphus/plans/my-plan.md",
  "session_ids": ["ses_abc123"],
  "task_sessions": {
    "task-1": { "session_id": "ses_def456", "agent": "sisyphus-junior" }
  }
}
```

This enables **true resume** across crashes, new chat sessions, or timeouts.

**For AICoder:** Our `checkpoint.json` only tracks stage index. We should also track:
- The original OpenCode session ID
- Per-stage subagent session IDs (for `task_id` resume)
- The playbook hash (to detect config changes)

### 2.5 Auto-Continue Injection

oh-my-openagent uses hooks to monitor `session.idle`. When a session goes idle with incomplete todos, it automatically injects a system reminder prompt ("continue the next task") instead of waiting for human input.

**For AICoder:** In Plan B, if AICoder finishes a stage but then stops (e.g. returns `finish: "stop"` too early), backend currently does nothing. We could inject a lightweight nudge message: *"Continue to the next stage in the playbook."*

### 2.6 Notepad Protocol

Atlas maintains a shared markdown notepad that is passed into every subagent prompt. It accumulates:
- Discovered patterns
- Mistakes made and corrected
- User preferences learned mid-flight

**For AICoder:** We could add a `run-{id}/notepad.md` that is appended to each stage prompt. This would let subagents learn from previous stages without re-embedding full JSON outputs.

---

## 3. Actionable Recommendations for AICoder

### Short-term (this week)

1. **Use `session.status` for idle detection**
   - Add `GET /session/status` to `OpenCodeClient`
   - Replace expensive `getMessages()` polling in progress trackers with a cheap status check

2. **Extract `task` results from `ToolPart` instead of text regex**
   - Update message parsing to look for `parts.find(p => p.type === "tool" && p.tool === "task")`
   - Fallback to text regex only for backward compatibility

3. **Enrich `checkpoint.json` with session IDs**
   - Store `opencode_session_id` and per-stage `subagent_session_id`s
   - This unlocks reliable resume and retry

### Medium-term (next 2 weeks)

4. **Adopt the Prometheus/Atlas separation**
   - Rewrite `AICoder.md` as a strict Atlas-like orchestrator
   - Remove any ambiguity that might let AICoder write code itself
   - Add explicit "conductor, not musician" identity framing

5. **Introduce per-stage model categories**
   - Map `clarify` → `quick`, `design` → `deep`, `dev` → `deep`, `test`/`review`/`validate` → `unspecified-high`
   - Backend resolves category to actual model via a configurable table

6. **Add auto-continue nudge for Plan B**
   - If no new JSON file appears for 2 minutes, send a `noReply` system message to the main session: *"Please continue with the next stage in the playbook."*

### Long-term (next month)

7. **Multi-agent verification wave**
   - After `dev`, run `test`, `review`, and `validate` subagents in parallel
   - Aggregate their outputs before marking the pipeline complete

8. **Context compaction integration**
   - Use `fork` or `summarize` every 3-4 stages to keep parent session context lean
   - This gives us the option to return to Plan A (stage-by-stage dispatch) if Plan B proves too fragile

---

## 4. Key Quotes to Remember

> *"A plan is decision-complete when the implementer needs ZERO judgment calls."* — Prometheus

> *"You are a conductor, not a musician. A general, not a soldier. You DELEGATE, COORDINATE, and VERIFY."* — Atlas

> *"Human intervention is a failure signal."* — oh-my-openagent manifesto

> *"Category describes INTENT, not implementation."* — oh-my-openagent orchestration guide
