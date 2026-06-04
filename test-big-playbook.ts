import { buildPipelinePlaybook } from './server/prompts/pipeline-dispatch.ts';

const sessionId = 'test-big-' + Date.now();
const playbook = buildPipelinePlaybook({
  mode: 'simple',
  stageOrder: ['clarify', 'dev'],
  sessionId,
  projectDir: '/tmp/test-project',
  workspaceDir: '/tmp/test-workspace',
  userInput: '写一个todo list demo，用 html 实现，细节你自己定',
});

console.log('Playbook size:', playbook.length, 'bytes');

const res = await fetch('http://localhost:8443/pipeline/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sessionId,
    playbook,
    workspaceDir: '/tmp/test-workspace',
    projectDir: '/tmp/test-project',
    mode: 'simple',
    model: 'opencode/gpt-5-nano',
  }),
});

console.log('Status:', res.status);
const text = await res.text();
console.log('Response:', text.slice(0, 200));
