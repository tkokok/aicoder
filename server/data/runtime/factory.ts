import { createOpenCodeRuntime, type OpenCodeRuntimeConfig } from './opencode.js';
import type { AgentRuntime } from './types.js';
import { createComponentLogger } from '../../logger.js';

const log = createComponentLogger('runtime-factory');

export function buildRuntimeConfigFromEnv(): Record<string, unknown> {
  return {
    type: process.env.RUNTIME_TYPE || 'opencode',
    mode: process.env.OPENCODE_MODE || 'external',
    url: process.env.OPENCODE_URL,
    header: process.env.OPENCODE_HEADER,
    username: process.env.OPENCODE_USERNAME,
    password: process.env.OPENCODE_PASSWORD,
  };
}

export async function createAgentRuntime(
  projectDir: string,
  runtimeConfigJson?: string
): Promise<AgentRuntime> {
  let config: Record<string, unknown>;
  if (runtimeConfigJson) {
    try {
      config = JSON.parse(runtimeConfigJson) as Record<string, unknown>;
    } catch {
      log.warn('Failed to parse runtime_config, falling back to env');
      config = buildRuntimeConfigFromEnv();
    }
  } else {
    config = buildRuntimeConfigFromEnv();
  }

  const type = (config.type as string) || 'opencode';

  if (type === 'opencode') {
    const opencodeConfig: OpenCodeRuntimeConfig = {
      type: 'opencode',
      mode: (config.mode as 'random' | 'external') || 'external',
      url: config.url as string | undefined,
      header: config.header as string | undefined,
      username: config.username as string | undefined,
      password: config.password as string | undefined,
    };
    return createOpenCodeRuntime(projectDir, opencodeConfig);
  }

  throw new Error(`Unsupported runtime type: ${type}`);
}
