// Bypass HTTP proxy for localhost connections
process.env.NO_PROXY = 'localhost,127.0.0.1,::1';
process.env.no_proxy = 'localhost,127.0.0.1,::1';

import { startControlPlane } from './control/index.js';
import { startDataPlane } from './data/index.js';
import logger from './logger.js';

async function main() {
  logger.info('Starting AICoder server', { component: 'main', mode: 'remote' });
  await startControlPlane({ port: parseInt(process.env.CONTROL_PLANE_PORT || '8080', 10) });

  const agentPort = parseInt(process.env.AGENT_PORT || '2080', 10);
  process.env.DEFAULT_AGENT_URL = `http://localhost:${agentPort}`;
  await startDataPlane({ port: agentPort });
}

main().catch((err) => {
  logger.error('Fatal error during startup', err, { component: 'main' });
  process.exit(1);
});
