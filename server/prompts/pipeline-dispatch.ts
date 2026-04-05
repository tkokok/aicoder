/**
 * Pipeline Playbook Generator
 *
 * Generates a single comprehensive playbook prompt that authorizes the AICoder
 * main agent to autonomously execute the entire pipeline.
 */

import type { PipelineStage, PipelineMode } from '../pipeline';

export interface PlaybookContext {
  mode: PipelineMode;
  stageOrder: PipelineStage[];
  sessionId: string;
  projectDir: string;
  workspaceDir: string;
  userInput: string;
}

const STAGE_VALIDATION: Record<PipelineStage, string> = {
  clarify: `MUST return either: status = "confirmed" OR a list of questions (≤ 3). MUST produce a complete clarified requirement summary.`,
  design: `MUST include: tech stack, architecture, API definition (if applicable), file structure. MUST be actionable for implementation.`,
  task: `MUST contain concrete implementation tasks. EACH task MUST include: description and done criteria.`,
  dev: `MUST include files_created or files_modified (non-empty). MUST match the design / task scope. Files MUST actually exist in the workspace directory.`,
  test: `MUST include test_files or execution_result. MUST report pass/fail status.`,
  review: `MUST include approved (true/false) and an issues list.`,
  validate: `MUST include status ("passed" or "failed") and verification details.`,
};

function buildStageSubagentPrompt(
  stage: PipelineStage,
  ctx: PlaybookContext
): string {
  const runDir = `${ctx.projectDir}/run-${ctx.sessionId}`;

  const stageSpecific: Record<PipelineStage, string> = {
    clarify: `Please clarify the user requirements. Ask ≤ 3 questions if anything is unclear.`,
    design: `Based on the clarified requirements, produce a technical design document. Read ${runDir}/clarify.json if you need the details.`,
    task: `Based on the design, break the work into concrete implementation tasks. Read ${runDir}/design.json if you need the details.`,
    dev: `Based on the task plan, implement the actual source code in ${ctx.workspaceDir}/. Read ${runDir}/task.json if you need the details.`,
    test: `Based on the implementation, write and run tests. Verify functionality. Read ${runDir}/dev.json if you need the details.`,
    review: `Review the implementation for quality, completeness, and alignment with the design. Read ${runDir}/dev.json and ${runDir}/test.json (if present).`,
    validate: `Perform final verification that all requirements are met. Read previous stage outputs in ${runDir}/ if needed.`,
  };

  return `You are the ${stage} subagent for the AICoder pipeline.

## Session Context
- Session ID: ${ctx.sessionId}
- Workspace Directory: ${ctx.workspaceDir}/
- Stage: ${stage}

## User Requirements
${ctx.userInput}

## Your Task
${stageSpecific[stage]}

## Validation Checklist
${STAGE_VALIDATION[stage]}

## Output Requirement (CRITICAL)
When you finish this stage, return ONLY a JSON object in your final assistant message and set finish="stop". Do NOT call any tool named finish.

The JSON MUST contain these exact keys:
{
  "status": "completed" | "failed",
  "output": { <stage-specific result data> },
  "error": "<error message if status is failed>"
}

For the **clarify** stage: ALWAYS return "status": "completed" even if you have questions. Put your questions inside "output.questions".
`.trim();
}

export function buildPipelinePlaybook(ctx: PlaybookContext): string {
  const runDir = `${ctx.projectDir}/run-${ctx.sessionId}`;

  const stageEntries = ctx.stageOrder.map((stage) => {
    const prompt = buildStageSubagentPrompt(stage, ctx);
    const indented = prompt.split('\n').map((line) => `  ${line}`).join('\n');
    return `## ${stage}
prompt: |\n${indented}`;
  });

  const validationEntries = Object.entries(STAGE_VALIDATION).map(([stage, rule]) => {
    return `- ${stage}: ${rule}`;
  });

  return `You are AICoder, the pipeline executor. You have been given a complete playbook. Your job is to execute every stage autonomously by calling the \`task\` tool for each subagent in sequence.

=== PIPELINE CONFIGURATION ===
- mode: ${ctx.mode}
- stage_order: [${ctx.stageOrder.join(', ')}]
- run_dir: ${runDir}
- workspace_dir: ${ctx.workspaceDir}/

=== STAGE PROMPTS ===
${stageEntries.join('\n\n')}

=== EXECUTION RULES (CRITICAL) ===
1. Iterate through stage_order in order.
2. Before calling \`task\` for a stage, output a visible text message:
   "🚀 Starting stage {index}/{total}: {stage_name}"
3. Call the \`task\` tool with:
   - description: a short 3-5 word summary of the stage
   - subagent_type: the exact stage name
   - prompt: the prompt provided for that stage above (forward it verbatim)
   - task_id: if retrying a failed attempt, reuse the previous task_id
4. WAIT for the \`task\` tool to return.
5. Validate the result using the checklist below.
6. Save the validated result as JSON to: ${runDir}/{stage_name}.json
   The JSON MUST contain:
   - status: "completed" or "failed"
   - subagent_session_id: the task_id from the task tool output
   - output: the subagent's actual result data
   - error: error message if status is "failed"
7. After saving, output:
   "✅ Stage {stage_name} completed."
8. If validation fails, retry the SAME stage up to 2 more times (3 total attempts). If it still fails, output:
   "❌ Pipeline halted at stage {stage_name}: {reason}"
   Then stop. Do not proceed to later stages.
9. After ALL stages complete successfully, output a brief summary and return ONLY:
   \`\`\`json
   { "finish": "stop", "status": "completed" }
   \`\`\`

=== VALIDATION CHECKLIST ===
${validationEntries.join('\n')}

=== HARD CONSTRAINTS ===
- You MUST NOT write or modify source code yourself.
- You MUST NOT produce design or architecture content yourself.
- You MUST NOT write or execute tests yourself.
- You MUST use the \`task\` tool for EVERY stage's actual work.
- NEVER call subagents named oracle, explore, or librarian.
`.trim();
}
