import { describe, expect, test } from 'bun:test';
import { TaskSchema, TaskOutput } from './task.schema';

describe('TaskSchema', () => {
  const validData: TaskOutput = {
    tasks: [
      {
        description: 'Create user authentication system',
        priority: 'high',
        dependencies: [],
      },
      {
        description: 'Implement user CRUD operations',
        priority: 'medium',
        dependencies: ['Create user authentication system'],
      },
    ],
  };

  test('validates correct data', () => {
    const result = TaskSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('rejects missing tasks array', () => {
    const result = TaskSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('rejects non-array tasks', () => {
    const result = TaskSchema.safeParse({ tasks: 'not an array' });
    expect(result.success).toBe(false);
  });

  test('rejects task without description', () => {
    const result = TaskSchema.safeParse({
      tasks: [{ priority: 'high', dependencies: [] }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects task without priority', () => {
    const result = TaskSchema.safeParse({
      tasks: [{ description: 'test', dependencies: [] }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects task without dependencies', () => {
    const result = TaskSchema.safeParse({
      tasks: [{ description: 'test', priority: 'high' }],
    });
    expect(result.success).toBe(false);
  });
});
