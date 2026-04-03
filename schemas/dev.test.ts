import { describe, expect, test } from 'bun:test';
import { DevSchema, DevOutput } from './dev.schema';

describe('DevSchema', () => {
  const validData: DevOutput = {
    files_created: ['src/index.ts', 'src/config.ts'],
    files_modified: ['package.json'],
    summary: 'Initial setup complete',
  };

  test('validates correct data', () => {
    const result = DevSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('rejects missing files_created', () => {
    const result = DevSchema.safeParse({
      files_modified: [],
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-array files_created', () => {
    const result = DevSchema.safeParse({
      files_created: 'not an array',
      files_modified: [],
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing summary', () => {
    const result = DevSchema.safeParse({
      files_created: [],
      files_modified: [],
    });
    expect(result.success).toBe(false);
  });

  test('allows empty arrays', () => {
    const result = DevSchema.safeParse({
      files_created: [],
      files_modified: [],
      summary: 'No files changed',
    });
    expect(result.success).toBe(true);
  });
});
