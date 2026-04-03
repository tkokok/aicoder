import { describe, expect, test } from 'bun:test';
import { ValidateSchema, ValidateOutput } from './validate.schema';

describe('ValidateSchema', () => {
  const validData: ValidateOutput = {
    validation_status: 'passed',
    api_tests: [
      { endpoint: '/api/users', method: 'GET', status: 200, response_time_ms: 45 },
      { endpoint: '/api/users/1', method: 'GET', status: 200, response_time_ms: 32 },
    ],
    summary: 'All API tests passed',
  };

  test('validates correct data', () => {
    const result = ValidateSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('rejects missing validation_status', () => {
    const result = ValidateSchema.safeParse({
      api_tests: [],
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('rejects invalid validation_status', () => {
    const result = ValidateSchema.safeParse({
      validation_status: 'pending',
      api_tests: [],
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('accepts failed status', () => {
    const result = ValidateSchema.safeParse({
      validation_status: 'failed',
      api_tests: [],
      summary: 'Tests failed',
    });
    expect(result.success).toBe(true);
  });

  test('rejects non-array api_tests', () => {
    const result = ValidateSchema.safeParse({
      validation_status: 'passed',
      api_tests: 'not an array',
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('rejects api_test without endpoint', () => {
    const result = ValidateSchema.safeParse({
      validation_status: 'passed',
      api_tests: [{ method: 'GET', status: 200, response_time_ms: 10 }],
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('rejects api_test without method', () => {
    const result = ValidateSchema.safeParse({
      validation_status: 'passed',
      api_tests: [{ endpoint: '/api', status: 200, response_time_ms: 10 }],
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('rejects api_test with non-number status', () => {
    const result = ValidateSchema.safeParse({
      validation_status: 'passed',
      api_tests: [{ endpoint: '/api', method: 'GET', status: '200', response_time_ms: 10 }],
      summary: 'test',
    });
    expect(result.success).toBe(false);
  });

  test('allows empty api_tests array', () => {
    const result = ValidateSchema.safeParse({
      validation_status: 'passed',
      api_tests: [],
      summary: 'No API tests defined',
    });
    expect(result.success).toBe(true);
  });
});
