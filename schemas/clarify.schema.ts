import { z } from 'zod';

export const ClarifySchema = z.object({
  clarified_requirements: z.string(),
  questions: z.array(z.string()),
  assumptions: z.array(z.string()),
});

export type ClarifyOutput = z.infer<typeof ClarifySchema>;
