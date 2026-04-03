import { describe, expect, test } from 'bun:test';
import { DesignSchema, DesignOutput } from './design.schema';

describe('DesignSchema', () => {
  const validData: DesignOutput = {
    architecture: 'Microservices with API Gateway',
    tech_stack: ['TypeScript', 'Node.js', 'Express', 'PostgreSQL'],
    file_structure: {
      src: { controllers: {}, models: {}, routes: {} },
      tests: {},
    },
    assumptions: ['High availability is required', 'Low latency is critical'],
  };

  test('validates correct data', () => {
    const result = DesignSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('rejects missing architecture', () => {
    const result = DesignSchema.safeParse({
      tech_stack: [],
      file_structure: {},
      assumptions: [],
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-array tech_stack', () => {
    const result = DesignSchema.safeParse({
      architecture: 'test',
      tech_stack: 'not an array',
      file_structure: {},
      assumptions: [],
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-object file_structure', () => {
    const result = DesignSchema.safeParse({
      architecture: 'test',
      tech_stack: [],
      file_structure: 'not an object',
      assumptions: [],
    });
    expect(result.success).toBe(false);
  });
});
