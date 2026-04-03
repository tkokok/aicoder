import { z } from 'zod';

export const TestResultsSchema = z.object({
  passed: z.number().nonnegative(),
  failed: z.number().nonnegative(),
  skipped: z.number().nonnegative(),
});

export const TestSchema = z.object({
  test_files: z.array(z.string()),
  test_results: TestResultsSchema,
  summary: z.string(),
});

export type TestOutput = z.infer<typeof TestSchema>;
