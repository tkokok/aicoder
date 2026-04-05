/**
 * Pipeline Playbook Generator
 *
 * Generates a single comprehensive playbook prompt that authorizes the AICoder
 * main agent to autonomously execute the entire pipeline.
 */

import type { PipelineStage, PipelineMode } from '../shared/types.js';

export interface PlaybookContext {
  mode: PipelineMode;
  stageOrder: PipelineStage[];
  sessionId: string;
  projectDir: string;
  workspaceDir: string;
  userInput: string;
}

const STAGE_VALIDATION: Record<PipelineStage, string> = {
  clarify: `MUST return JSON with: status="completed", clarified_requirements (string), assumptions (array), scope_boundaries (array), success_criteria (array). questions should be empty array [].`,
  design: `MUST return JSON with: architecture (object with components, data_flow), tech_stack (object with exact versions), file_structure (files array with path/purpose/lines_estimate), api_design (endpoints with request/response schemas), implementation_notes (array), assumptions (array).`,
  task: `[DEPRECATED - NOT USED] This stage has been removed from the pipeline.`,
  dev: `MUST return JSON with: inputs_read (array), files (array with path/type/lines/description), tests (array with path/coverage), implementation_summary (string), requirements_coverage (array mapping requirements to implemented/tested status).`,
  test: `MUST return JSON with: inputs_read (array), requirements_coverage (object with total/covered/partially_covered/not_covered), test_execution (object with total/passed/failed/skipped), failed_tests (array), gaps (array), recommendations (array).`,
  review: `MUST return JSON with: inputs_read (array), approved (boolean), approval_conditions (array if approved), blockers (array if not approved), issues (array with severity/file/line/description), requirements_verification (array mapping requirements to satisfied status).`,
  validate: `MUST include status ("passed" or "failed") and verification details.`,
};

function buildStageSubagentPrompt(
  stage: PipelineStage,
  ctx: PlaybookContext
): string {
  const runDir = `${ctx.projectDir}/run-${ctx.sessionId}`;

  const stageSpecific: Record<PipelineStage, string> = {
    clarify: `Please clarify the user requirements. Analyze the requirements and produce a clarified specification with assumptions and success criteria.`,
    design: `Based on the clarified requirements, produce a comprehensive technical design. Read ${runDir}/clarify.json to understand the requirements, assumptions, and success criteria. Output structured design with architecture, tech stack (exact versions), file structure, and API contracts.`,
    task: `[DEPRECATED] This stage has been removed. Do not use.`,
    dev: `Based on the design specification, implement the actual source code in ${ctx.workspaceDir}/. Read ${runDir}/design.json for architecture, tech stack, file structure, and API contracts. Implement ALL files specified in the design, write tests, and verify requirements coverage.`,
    test: `Based on the implementation, validate test coverage against requirements. Read ${runDir}/clarify.json for success criteria and ${runDir}/dev.json for implementation details. Run tests and report coverage gaps.`,
    review: `Review the implementation for quality, security, and adherence to requirements. Read ${runDir}/clarify.json (requirements), ${runDir}/design.json (design spec), ${runDir}/dev.json (implementation), and ${runDir}/test.json (test results). Output approved: true/false with specific issues.`,
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
3. Call the \`task\` tool with ALL of these fields:
   - description: a short 3-5 word summary of the stage
   - subagent_type: the exact stage name
   - prompt: the prompt provided for that stage above (forward it verbatim)
   - run_in_background: false (REQUIRED)
   - load_skills: [] (REQUIRED, pass empty array if no skills needed)
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
