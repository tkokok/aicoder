import { describe, expect, test } from 'bun:test';
import { ClarifySchema, ClarifyOutput } from './clarify.schema';

describe('ClarifySchema', () => {
  const validData: ClarifyOutput = {
    clarified_requirements: 'Build a REST API for user management',
    questions: ['What database should we use?', 'Should we implement authentication?'],
    assumptions: ['Users will be authenticated via JWT', 'Database is PostgreSQL'],
  };

  test('validates correct data', () => {
    const result = ClarifySchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('rejects missing clarified_requirements', () => {
    const result = ClarifySchema.safeParse({
      questions: [],
      assumptions: [],
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-array questions', () => {
    const result = ClarifySchema.safeParse({
      clarified_requirements: 'test',
      questions: 'not an array',
      assumptions: [],
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-array assumptions', () => {
    const result = ClarifySchema.safeParse({
      clarified_requirements: 'test',
      questions: [],
      assumptions: 'not an array',
    });
    expect(result.success).toBe(false);
  });
});
