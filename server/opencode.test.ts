import { describe, test, expect, beforeAll } from 'bun:test';
import { join } from 'path';
import { 
  OpenCodeClient, 
  createOpenCodeClient, 
  loadAgents, 
  parseFrontmatter,
  type Agent,
  type AgentFrontmatter 
} from './opencode';

describe('parseFrontmatter', () => {
  test('parses frontmatter with all fields', () => {
    const content = `---
description: Main orchestrator agent
mode: primary
model: anthropic/claude-sonnet-4-20250514
---

# Role: Main Orchestrator

Content here.`;

    const result = parseFrontmatter(content);
    
    expect(result.frontmatter.description).toBe('Main orchestrator agent');
    expect(result.frontmatter.mode).toBe('primary');
    expect(result.frontmatter.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(result.body).toContain('# Role: Main Orchestrator');
  });

  test('parses frontmatter with minimal fields', () => {
    const content = `---
mode: subagent
---

# Role: Developer

Content here.`;

    const result = parseFrontmatter(content);
    
    expect(result.frontmatter.mode).toBe('subagent');
    expect(result.frontmatter.description).toBeUndefined();
    expect(result.frontmatter.model).toBeUndefined();
  });

  test('handles content without frontmatter', () => {
    const content = `# Role: Developer

Content without frontmatter.`;

    const result = parseFrontmatter(content);
    
    expect(result.frontmatter.mode).toBe('subagent');
    expect(result.body).toBe(content);
  });
});

describe('loadAgents', () => {
  test('loads all agent files from agents directory', async () => {
    const agentsDir = join(process.cwd(), 'agents');
    const agents = await loadAgents(agentsDir);
    
    expect(agents.length).toBe(8);
    
    const agentNames = agents.map(a => a.name).sort();
    expect(agentNames).toEqual([
      'clarify',
      'design',
      'dev',
      'main',
      'review',
      'task',
      'test',
      'validate'
    ]);
  });

  test('each agent has required properties', async () => {
    const agentsDir = join(process.cwd(), 'agents');
    const agents = await loadAgents(agentsDir);
    
    for (const agent of agents) {
      expect(agent.name).toBeDefined();
      expect(agent.path).toBeDefined();
      expect(agent.frontmatter).toBeDefined();
      expect(agent.content).toBeDefined();
      expect(['primary', 'subagent']).toContain(agent.frontmatter.mode);
    }
  });

  test('main agent has primary mode', async () => {
    const agentsDir = join(process.cwd(), 'agents');
    const agents = await loadAgents(agentsDir);
    
    const mainAgent = agents.find(a => a.name === 'main');
    expect(mainAgent).toBeDefined();
    expect(mainAgent!.frontmatter.mode).toBe('primary');
    expect(mainAgent!.frontmatter.description).toBeDefined();
    expect(mainAgent!.frontmatter.model).toBeDefined();
  });

  test('subagents have subagent mode', async () => {
    const agentsDir = join(process.cwd(), 'agents');
    const agents = await loadAgents(agentsDir);
    
    const subagents = agents.filter(a => a.name !== 'main');
    for (const agent of subagents) {
      expect(agent.frontmatter.mode).toBe('subagent');
    }
  });

  test('returns empty array for non-existent directory', async () => {
    const agents = await loadAgents('/non/existent/path');
    expect(agents).toEqual([]);
  });
});

describe('OpenCodeClient', () => {
  test('creates client with default config', () => {
    const client = createOpenCodeClient();
    
    expect(client).toBeInstanceOf(OpenCodeClient);
  });

  test('creates client with custom config', () => {
    const client = createOpenCodeClient({
      baseUrl: 'http://custom:9000',
      directory: '/custom/path',
      timeout: 60000,
    });
    
    expect(client).toBeInstanceOf(OpenCodeClient);
  });

  test('getAgents returns empty array before initialization', () => {
    const client = createOpenCodeClient();
    
    expect(client.getAgents()).toEqual([]);
  });

  test('getAgent returns undefined for non-existent agent', () => {
    const client = createOpenCodeClient();
    
    expect(client.getAgent('nonexistent')).toBeUndefined();
  });

  test('initialize loads agents', async () => {
    const client = createOpenCodeClient();
    await client.initialize(join(process.cwd(), 'agents'));
    
    const agents = client.getAgents();
    expect(agents.length).toBe(8);
    
    const mainAgent = client.getAgent('main');
    expect(mainAgent).toBeDefined();
    expect(mainAgent!.frontmatter.mode).toBe('primary');
  });
});

describe('OpenCodeClient HTTP methods', () => {
  test('isAvailable returns false when server not running', async () => {
    const client = createOpenCodeClient({
      baseUrl: 'http://localhost:9999', // Non-existent server
      timeout: 1000,
    });
    
    const available = await client.isAvailable();
    expect(available).toBe(false);
  });
});