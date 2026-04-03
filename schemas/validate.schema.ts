import { z } from 'zod';

export const ApiTestSchema = z.object({
  endpoint: z.string(),
  method: z.string(),
  status: z.number(),
  response_time_ms: z.number(),
});

export const ValidateSchema = z.object({
  validation_status: z.enum(['passed', 'failed']),
  api_tests: z.array(ApiTestSchema),
  summary: z.string(),
});

export type ValidateOutput = z.infer<typeof ValidateSchema>;
