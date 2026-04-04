# Learning: Atlas Master Orchestrator Agent (oh-my-openagent)

## Source
`../oh-my-openagent/src/agents/atlas/`

## Core Identity

**Atlas is the Master Orchestrator Agent.**

> "Orchestrates work via task() to complete ALL tasks in a todo list until fully done. You are the conductor of a symphony of specialized agents."

Unlike Prometheus (planner) or Sisyphus (executor), Atlas specifically focuses on **todo-list-driven orchestration** — reading a plan, breaking it into waves, and dispatching to the right category of subagents until every checkbox is checked.

## Dynamic Prompt Building

Atlas's prompt is dynamically built based on:
1. **Model type** (Claude default, GPT optimized, Gemini optimized)
2. **Available agents** (Oracle, Explore, Librarian, etc.)
3. **Available tools**
4. **Available skills**
5. **User-defined categories**

This is a critical architectural insight: **the orchestrator's prompt is not static**. It changes based on runtime capabilities.

## Category-Based Dispatch

Atlas uses a category system to route tasks to the right agent profile:

| Category | Typical Use |
|----------|-------------|
| `quick` | Small fixes, config changes, simple refactors |
| `deep` | Complex logic, architecture, debugging |
| `unspecified-high` | High-quality implementation when no specific category fits |
| `unspecified-low` | Simple, low-stakes tasks |
| `visual-engineering` | UI/UX, CSS, frontend components |
| `ultrabrain` | Research-heavy, open-ended thinking |
| `artistry` | Creative tasks, different approaches needed |
| `writing` | Documentation, copy, markdown |

Each category can have:
- Default model override
- Specific skills to auto-load
- Temperature/top-p settings
- Tool restrictions

## Agent Selection Section

Atlas builds a decision matrix for the model:

```
### Delegation Table:
- **Architecture / Debugging / Complex logic** → `oracle` - Consult before implementing
- **Internal codebase search** → `explore` - Find patterns in THIS repo
- **External docs / library best practices** → `librarian` - Search external resources
- **QA / Rigorous verification** → `momus` - Review and find issues
- **Gap analysis / planning review** → `metis` - Catch missed requirements
```

## Key Lesson for AICoder

### 1. Static Prompts Are Brittle
AICoder's current `AICoder.md` is a static markdown file with a fixed 7-stage pipeline. When `glm-5.1` injected `[analyze-mode]`, the model completely ignored our static constraints.

**Solution**: Build the orchestrator prompt dynamically, embedding:
- Anti-injection guards at the VERY TOP
- Stage definitions as structured data (JSON/YAML) rather than prose
- Available agent list derived from actual filesystem
- Model-specific enforcement clauses

### 2. Category-Based Routing Instead of Name-Based
Currently AICoder dispatches by exact agent name (`clarify`, `design`, `dev`, etc.). This is rigid.

The oh-my-openagent approach is to dispatch by **category + task description**. The system then resolves category → agent configuration.

For AICoder, this could mean:
- `clarify` → category `quick` (requirements gathering)
- `design` → category `deep` (architecture thinking)
- `dev` → category `unspecified-high` or `visual-engineering`
- `test` → category `quick` with `playwright` skill if UI
- `review` → category `deep` (code review)
- `validate` → category `quick` (verification runner)

### 3. Todo-Driven State Machine
Atlas's entire behavior is driven by a todo list in the plan. AICoder currently uses a hardcoded stage order (`clarify → design → task → dev → test → review → validate`).

A more flexible approach:
1. Planner creates a todo list with stages, waves, and dependencies
2. Orchestrator reads the todo list and dispatches accordingly
3. Progress is measured by "which todos are checked" rather than "which hardcoded stage"

This allows:
- Skipping unnecessary stages (e.g., simple bugfix doesn't need clarify/design)
- Parallel waves (e.g., Wave 1: dev tasks 1-3 in parallel, Wave 2: integration tests)
- Dynamic retry (re-open a todo and re-delegate rather than failing the whole pipeline)
