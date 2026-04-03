import { describe, expect, test } from 'bun:test';
import { TestSchema, TestOutput } from './test.schema';

describe('TestSchema', () => {
  const validData: TestOutput = {
    test_files: ['tests/user.test.ts', 'tests/auth.test.ts'],
    test_results: {
      passed: 42,
      failed: 2,
      skipped: 1,
    },
    summary: '44 tests run, 2 failures',
  };

  test('validates correct data', () => {
    const result = TestSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('rejects missing test_files', () => {
    const result = TestSchema.safeParse({
      test_results: { passed: 0, failed: 0, skipped: 0 },
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing test_results', () => {
    const result = TestSchema.safeParse({
      test_files: [],
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('rejects invalid test_results shape', () => {
    const result = TestSchema.safeParse({
      test_files: [],
      test_results: { total: 10 },
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('rejects negative test counts', () => {
    const result = TestSchema.safeParse({
      test_files: [],
      test_results: { passed: -1, failed: 0, skipped: 0 },
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });
});
