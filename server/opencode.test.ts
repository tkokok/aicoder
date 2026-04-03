import { describe, test, expect } from 'bun:test';
import { OpenCodeClient, OpenCodeManager } from './opencode';
import type { PromptPart } from './opencode';

describe('OpenCodeClient', () => {
  test('creates client with config', () => {
    const client = new OpenCodeClient({
      baseUrl: 'http://localhost:4096',
      directory: '/tmp/test-project',
    });

    expect(client).toBeInstanceOf(OpenCodeClient);
  });

  test('isAvailable returns false when server not running', async () => {
    const client = new OpenCodeClient({
      baseUrl: 'http://localhost:59999',
      directory: '/tmp/test-project',
    });

    const available = await client.isAvailable();
    expect(available).toBe(false);
  });
});

describe('OpenCodeManager', () => {
  test('is a singleton', () => {
    expect(OpenCodeManager).toBeDefined();
    expect(typeof OpenCodeManager.getOrCreate).toBe('function');
    expect(typeof OpenCodeManager.shutdown).toBe('function');
    expect(typeof OpenCodeManager.shutdownAll).toBe('function');
  });
});

describe('PromptPart', () => {
  test('text part type', () => {
    const part: PromptPart = { type: 'text', text: 'hello' };
    expect(part.type).toBe('text');
    expect(part.text).toBe('hello');
  });

  test('file part type', () => {
    const part: PromptPart = {
      type: 'file',
      url: 'file:///tmp/test.txt',
      mime: 'text/plain',
      filename: 'test.txt',
    };
    expect(part.type).toBe('file');
  });
});
