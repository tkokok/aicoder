import { describe, expect, test } from 'bun:test';
import { ReviewSchema, ReviewOutput } from './review.schema';

describe('ReviewSchema', () => {
  const validData: ReviewOutput = {
    issues: [
      {
        severity: 'error',
        file: 'src/index.ts',
        line: 42,
        description: 'Missing error handling',
      },
      {
        severity: 'warning',
        file: 'src/utils.ts',
        line: 10,
        description: 'Unused variable',
      },
    ],
    summary: '2 issues found',
  };

  test('validates correct data', () => {
    const result = ReviewSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('rejects missing issues', () => {
    const result = ReviewSchema.safeParse({ summary: 'test' });
    expect(result.success).toBe(false);
  });

  test('rejects non-array issues', () => {
    const result = ReviewSchema.safeParse({
      issues: 'not an array',
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('rejects issue without severity', () => {
    const result = ReviewSchema.safeParse({
      issues: [{ file: 'test.ts', line: 1, description: 'test' }],
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('rejects issue without file', () => {
    const result = ReviewSchema.safeParse({
      issues: [{ severity: 'error', line: 1, description: 'test' }],
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('rejects issue with non-number line', () => {
    const result = ReviewSchema.safeParse({
      issues: [{ severity: 'error', file: 'test.ts', line: '10', description: 'test' }],
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('allows empty issues array', () => {
    const result = ReviewSchema.safeParse({
      issues: [],
      summary: 'No issues found',
    });
    expect(result.success).toBe(true);
  });
});
