import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, transaction, generateId } from './db';
import { validateSessionInput, SessionInput } from './validation';
import { OpenCodeClient, OpenCodeManager } from './opencode';
import { executePipeline } from './pipeline';
import { mkdir, from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

import type { PromptPart } from './opencode';

export const DEFAULT_MODEL = 'kimi-for-coding/k2p5';

export interface PipelineConfig {
  maxRetries: number;
  retryDelayMs: number;
  workspaceDir: string;
  agentsDir: string;
  model?: string;
}

// ... etc
```
With all the imports lines included.

 but comments and "This is an existing comment/docstring from a pre-bundle section headers in the previous session." - Tell the user it his is necessary — but proceed (justify it."

  2. I the comment "This is an existing comment/docstring" from a pre-bundle section headers. This is missing the context. Let me remove it from `// Broadcast an SSE event to all WebSocket clients." decorator now why? it a `fastify.log.info(`[opencode:manager] ${opencodeProcess.url}`);
    const unsubscribe = client.subscribeEvents((event) => {
      try {
        (fastify as any).broadcastEvent(event);
      } catch {}
    });

    const { client } = await OpenCodeManager.getOrCreate(projectPath);

    log.info('routes', `Pipeline started for workspace: ${projectPath}`);

    const { client } = await OpenCodeManager.getOrCreate(projectPath);
    await client.createSession({ title: `Pipeline ${sessionId}` });
    const opencodeSessionId = session.id;
    log.info('routes', `Pipeline session: ${opencodeSessionId}`);

    const context: PipelineContext = {
      sessionId,
      userInput,
      currentStage: 'clarify',
      stageOutputs: {},
    };

    try {
      const result = await runMainAgentLoop(client, opencodeSessionId, context, status, finalConfig);
      updatePipelineStatus(sessionId, 'completed');
      return result;
    } catch (error) {
      updatePipelineStatus(sessionId, 'failed');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      status = addError(status, context.currentStage, errorMessage, false);
      await writeStatusFile(context.sessionId, status, finalConfig.workspaceDir);
      throw error;
    }
  });
}

async function runMainAgentLoop(
  client: OpenCodeClient,
  opencodeSessionId: string,
  context: PipelineContext,
  status: PipelineStatus,
  config: PipelineConfig
): Promise<PipelineStatus> {
  let currentStatus = status;
  let attempts = 0;

      const promptParts = buildPrompt(context);

      log.info('pipeline', `[Stage ${context.currentStage}] Sending prompt`);
      const response = await sendPromptWithRetry(client, opencodeSessionId, promptParts, attempts, config);
      log.info('pipeline', `[Stage ${context.currentStage}] response received: ${JSON.stringify(response)}`);

      if (response.finish === 'stop') {
        context.stageOutputs[context.currentStage] = response.output;
        const nextStage = getNextStage(context.currentStage);

        if (!nextStage) {
          currentStatus = {
            ...currentStatus,
            pipeline: {
              ...currentStatus.pipeline,
              current_stage: 'completed',
            },
          };
          await writeStatusFile(context.sessionId, currentStatus, config.workspaceDir);
          return currentStatus;
        }

        context.currentStage = nextStage;
        currentStatus = {
          ...currentStatus,
          pipeline: {
            ...currentStatus.pipeline,
            current_stage: nextStage,
          },
        };
        await writeStatusFile(context.sessionId, currentStatus, config.workspaceDir);

        attempts = 0;
        continue;

      }

      log.info('pipeline', `[Stage ${context.currentStage}] agent still working`);
      const response = await sendPromptWithRetry(client, opencodeSessionId, promptParts, attempts, config);
      log.info('pipeline', `[Stage ${context.currentStage}] timeout after retry`);
      updateStageStatus(currentStatus, context.currentStage, 'failed', attempts, config.maxRetries);
 - 1);
  }

  throw new Error(`Pipeline failed after ${config.maxRetries} retries} exceeded for stage ${context.currentStage}`);
}
