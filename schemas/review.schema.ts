import { z } from 'zod';

export const ReviewIssueSchema = z.object({
  severity: z.string(),
  file: z.string(),
  line: z.number(),
  description: z.string(),
});

export const ReviewSchema = z.object({
  issues: z.array(ReviewIssueSchema),
  summary: z.string(),
});

export type ReviewOutput = z.infer<typeof ReviewSchema>;
