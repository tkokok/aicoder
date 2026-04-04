# Agent Orchestration Architecture

> Lessons learned from building AICoder on top of OpenCode.

## The `@mention` Trap

A common misconception when building on OpenCode is that writing `@clarify` (or any `@agent_name`) in the assistant's text response will trigger that agent. **It does not.**

OpenCode's assistant message parser does **not** treat `@mentions` as agent routing signals. The `@` prefix is only meaningful in **user-facing UI** (e.g. when a human types `@agent` in the chat input). When an assistant model writes `@clarify` in its response, it is treated as plain text, and the message finishes with `finish: "stop"` or `finish: "tool-calls"` depending on whether actual tools were invoked.

## The Correct Mechanism: `task` Tool

Sub-agents in OpenCode are launched exclusively through the built-in **`task` tool**.

### Tool Schema

```typescript
{
  description: string,   // 3-5 word summary
  prompt: string,        // Full instructions for the sub-agent
  subagent_type: string, // Agent name: clarify | design | task | dev | test | review | validate
  task_id?: string,      // Optional: resume an existing sub-agent session
  command?: string       // Optional: slash command that triggered this
}
```

### Example Invocation

```js
task({
  description: "Clarify requirements",
  prompt: `The user wants a TodoList demo with TypeScript.
Requirements: add, delete, edit, track creation time and estimated completion time.
Please confirm the exact scope and produce a clarified requirement summary.`,
  subagent_type: "clarify"
})
```

### What Happens Under the Hood

1. OpenCode receives the `task` tool call from the primary agent
2. It looks up the agent definition matching `subagent_type` in `.opencode/agent/{name}.md`
3. It creates a **new child session** (or resumes one if `task_id` is provided)
4. It runs the sub-agent with the provided `prompt`
5. The sub-agent's final response is wrapped in a tool result and returned to the primary agent

## Prompt Engineering for the Primary Agent

The primary agent (AICoder) must be instructed **explicitly and repeatedly** to:

1. Use the `task` tool for EVERY stage
2. Pass the correct `subagent_type` matching the stage name
3. WAIT for the tool result before proceeding to the next stage
4. Save the result as JSON to the run directory
5. Never do the sub-agent's work itself

### Anti-patterns to Avoid in Prompts

| ❌ Bad Instruction | ✅ Good Instruction |
|-------------------|---------------------|
| "Write `@clarify` in your response" | "Call the `task` tool with `subagent_type: "clarify"`" |
| "DO NOT use the `task` tool" | "You MUST use the `task` tool to invoke sub-agents" |
| "After writing `@agent_name`, wait" | "After the `task` tool returns, validate and proceed" |

## Agent Naming

We renamed the primary orchestrator from `main` to `AICoder` to avoid confusion with OpenCode's internal conventions.

- **Agent file**: `agents/AICoder.md`
- **API parameter**: `agent: "AICoder"`
- **Sub-agents**: `agents/clarify.md`, `agents/design.md`, `agents/task.md`, `agents/dev.md`, `agents/test.md`, `agents/review.md`, `agents/validate.md`

## Retry & Validation Policy

For each stage:
- Max 3 attempts total (initial + 2 retries)
- If validation fails, call the **same** `task` tool again with feedback
- If a stage still fails after 3 attempts, stop the pipeline and mark it `failed`

## Reference: OpenCode task.txt

OpenCode's built-in `task` tool description (`packages/opencode/src/tool/task.txt`) explicitly says:

> "Launch a new agent to handle complex, multistep tasks autonomously... When using the Task tool, you must specify a `subagent_type` parameter to select which agent type to use."

This confirms that `task` is the canonical sub-agent launcher.
