# Learning: Prometheus Planning Agent (oh-my-openagent)

## Source
`../oh-my-openagent/src/agents/prometheus/`

## Core Identity

**Prometheus is a STRICT planner. It NEVER implements.**

> "YOU ARE A PLANNER. YOU ARE NOT AN IMPLEMENTER. YOU DO NOT WRITE CODE. YOU DO NOT EXECUTE TASKS."

When user says "do X", "build X", "fix X" — Prometheus ALWAYS interprets this as: **"Create a work plan for X"**.

## Key Behaviors

### 1. Interview Mode by Default
- Default behavior is to interview the user to understand requirements
- Uses `explore` / `librarian` agents to gather context
- After EVERY interview turn, runs a **CLEARANCE CHECKLIST**:
  - Core objective clearly defined?
  - Scope boundaries established (IN/OUT)?
  - No critical ambiguities remaining?
  - Technical approach decided?
  - Test strategy confirmed?
  - No blocking questions outstanding?
- **IF all YES**: Auto-transition to Plan Generation
- **IF any NO**: Continue interview

### 2. Continuous Draft as Working Memory
During interview, CONTINUOUSLY records decisions to:
```
.sisyphus/drafts/{name}.md
```
Draft updates triggered after EVERY meaningful user response, agent research result, or decision.

### 3. Plan Generation Trigger
Auto-transition when clearance passes, OR explicit triggers:
- "Make it into a work plan!"
- "Create the work plan"
- "Save it as a file"
- "Generate the plan"

### 4. Metis Consultation (MANDATORY)
Before generating plan, summons `metis` subagent to catch gaps:
- Questions that should have been asked
- Guardrails to set
- Scope creep areas to lock down
- Assumptions needing validation
- Missing acceptance criteria
- Edge cases not addressed

### 5. Single Plan Mandate
No matter how large, EVERYTHING goes into ONE work plan:
```
.sisyphus/plans/{plan-name}.md
```

### 6. Incremental Write Protocol
Plans with many tasks exceed output token limits. Split into:
- **One Write** (skeleton with all sections except task details)
- **Multiple Edits** (append tasks in batches of 2-4)
- **Final Read** (verify completeness)

### 7. Maximum Parallelism Principle
- One task = one module/concern = 1-3 files
- If a task touches 4+ files or 2+ unrelated concerns, SPLIT IT
- Parallelism target: 5-8 tasks per wave
- Fewer than 3 per wave (except final) = under-splitting
- Shared dependencies extracted as early Wave-1 tasks

### 8. Gap Classification & Self-Review
After generating plan, self-review gaps:
- **CRITICAL**: Requires user input → ask immediately
- **MINOR**: Can self-resolve → fix silently, note in summary
- **AMBIGUOUS**: Default available → apply default, disclose in summary

### 9. Turn Termination Rules (CRITICAL)
Every turn MUST end with ONE of:
- Question to user
- Draft update + next question
- Waiting for background agents
- Auto-transition to plan

**NEVER end with**: passive statements like "Let me know if you have questions"

## Plan Structure

```markdown
# {Plan Title}

## TL;DR
> Quick Summary
> Deliverables
> Estimated Effort
> Parallel Execution
> Critical Path

## Context
### Original Request
### Interview Summary
### Metis Review

## Work Objectives
### Core Objective
### Concrete Deliverables
### Definition of Done
### Must Have
### Must NOT Have (Guardrails)

## Verification Strategy
### Test Decision
### QA Policy

## Execution Strategy
### Parallel Execution Waves
Wave 1 (foundation):
├── Task 1: ...
├── Task 2: ...

Wave 2 (core modules):
├── Task 8: ...

Wave FINAL (4 parallel reviews):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review
├── F3: Real manual QA
└── F4: Scope fidelity check

## TODOs
- [ ] 1. [Task Title]
  **What to do**: ...
  **Must NOT do**: ...
  **Recommended Agent Profile**: category + skills
  **Parallelization**: Wave N, dependencies
  **References**: existing code patterns, API contracts, tests
  **Acceptance Criteria**: agent-executable verification
  **QA Scenarios**: happy path + failure/edge case

## Final Verification Wave
- [ ] F1. Plan Compliance Audit — oracle
- [ ] F2. Code Quality Review
- [ ] F3. Real Manual QA
- [ ] F4. Scope Fidelity Check

## Commit Strategy
## Success Criteria
```

## Key Lesson for AICoder
**Separate planning from execution.**

Currently AICoder mixes both: the main agent is expected to plan (7 stages) AND dispatch AND validate AND save JSON. This is too much for one prompt. The Prometheus pattern suggests:

1. **Planner agent** creates a structured, parallelized work plan
2. **Executor agent** reads the plan and dispatches subagents in waves
3. **Main controller** only tracks high-level progress and handles failures
