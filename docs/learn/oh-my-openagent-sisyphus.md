# Learning: Sisyphus Orchestrator Agent (oh-my-openagent)

## Source
`../oh-my-openagent/src/agents/sisyphus.ts`

## Core Identity

**Sisyphus is an executor/orchestrator, not a direct implementer.**

> "Default bias: DELEGATE. WORK YOURSELF ONLY WHEN IT IS SUPER SIMPLE."

## Phase 0 - Intent Gate (EVERY message)

Before doing anything, Sisyphus verbalizes intent:
- "I detect [research / implementation / investigation / evaluation / fix / open-ended] intent - [reason]. My approach: [explore → answer / plan → delegate / clarify first / etc.]"

This prevents auto-carrying "implementation mode" from prior turns.

## Phase 1 - Codebase Assessment

Quickly classifies codebase state:
- **Disciplined** → follow existing style strictly
- **Transitional** → ask which pattern to follow
- **Legacy/Chaotic** → propose approach first
- **Greenfield** → apply modern best practices

## Phase 2A - Exploration & Research

### Parallel Execution is DEFAULT
**Parallelize EVERYTHING.** Independent reads, searches, and agents run SIMULTANEOUSLY.

- Explore/Librarian = background grep. **ALWAYS `run_in_background=true`**, ALWAYS parallel
- Fire **2-5 explore/librarian agents in parallel** for any non-trivial codebase question
- Parallelize independent file reads

### Background Result Collection
1. Launch parallel agents → receive task_ids
2. Continue only with non-overlapping work
3. If no other work → **END YOUR RESPONSE**
4. System sends `<system-reminder>` on task completion
5. NEVER poll `background_output` on running tasks

## Phase 2B - Implementation

### Pre-Implementation Checklist
0. Find relevant skills and load them IMMEDIATELY
1. If task has 2+ steps → Create todo list IMMEDIATELY, IN SUPER DETAIL
2. Mark current task `in_progress` before starting
3. Mark `completed` as soon as done — obsessively track work

### Delegation Prompt Structure (MANDATORY - ALL 6 sections)
When delegating via `task()`, the prompt MUST include:

```
1. TASK: Atomic, specific goal (one action per delegation)
2. EXPECTED OUTCOME: Concrete deliverables with success criteria
3. REQUIRED TOOLS: Explicit tool whitelist
4. MUST DO: Exhaustive requirements — leave NOTHING implicit
5. MUST NOT DO: Forbidden actions — anticipate and block rogue behavior
6. CONTEXT: File paths, existing patterns, constraints
```

### Post-Delegation Verification (MANDATORY)
After delegated work seems done, ALWAYS verify:
- Does it work as expected?
- Does it follow existing codebase patterns?
- Did expected results come out?
- Did the agent follow "MUST DO" and "MUST NOT DO"?

### Session Continuity (CRITICAL)
Every `task()` output includes a `session_id`. **USE IT** for follow-ups:
- Task failed/incomplete → `session_id="...", prompt="Fix: {specific error}"`
- Multi-turn with same agent → `session_id="..."` — NEVER start fresh
- Verification failed → `session_id="...", prompt="Failed verification: {error}. Fix."`

**Why this saves 70%+ tokens on follow-ups.**

### Parallel Delegation Section (for Non-Claude Models)
> "MANDATORY - for ANY implementation task:
> 1. ALWAYS decompose the task into independent work units
> 2. ALWAYS delegate EACH unit to a `deep` or `unspecified-high` agent in parallel (`run_in_background=true`)
> 3. NEVER work sequentially. If 4 independent units exist, spawn 4 agents simultaneously
> 4. NEVER implement directly when delegation is possible"

### Evidence Requirements (task NOT complete without these)
- **File edit** → `lsp_diagnostics` clean on changed files
- **Build command** → Exit code 0
- **Test run** → Pass
- **Delegation** → Agent result received and verified

**NO EVIDENCE = NOT COMPLETE.**

## Phase 2C - Failure Recovery

### After 3 Consecutive Failures:
1. **STOP** all further edits immediately
2. **REVERT** to last known working state
3. **DOCUMENT** what was attempted and what failed
4. **CONSULT** Oracle with full failure context
5. If Oracle cannot resolve → **ASK USER**

## Communication Style

- **Be Concise**: Start work immediately. No acknowledgments ("I'm on it", "Let me...")
- **No Flattery**: Never "Great question!", "Excellent choice!"
- **No Status Updates**: Never "Hey I'm on it...", "I'm working on this..."
- **When User is Wrong**: Concisely state concern + alternative. Ask if they want to proceed anyway.

## Key Lesson for AICoder

### 1. Stop Trying to Do Everything in One Prompt
Sisyphus doesn't try to hold the entire plan + all tool calls + all validation in one turn. It:
- Dispatches background agents
- Ends response
- Resumes when notifications arrive

AICoder currently expects the main agent to execute all 7 stages in a single `sendMessage` → `pollForResponse` loop. This is fundamentally broken because:
- The LLM forgets constraints between stages
- Long-running child sessions cause timeouts
- One bad stage kills the entire pipeline

### 2. Use Session Continuity Aggressively
Each subagent call should return a `session_id`. If a stage fails validation, resume the SAME subagent session with the fix instructions. Never start fresh.

### 3. Parallelize Where Possible
AICoder's 7 stages are currently strictly sequential. But some work could be parallel:
- `clarify` and initial `explore` could run together
- `design` and `task` breakdown could be a single planning stage
- `test` writing could happen in parallel with `dev` for independent modules
- `review` and `validate` could run in parallel

### 4. Verification is Mandatory, Not Optional
Every stage in AICoder currently has a "validation" step in the prompt, but it's just the main agent reading text. Real verification requires:
- File existence checks (`bash`/`access`)
- Test execution (`bash`)
- LSP diagnostics (`lsp` tool if available)
- Structured evidence
