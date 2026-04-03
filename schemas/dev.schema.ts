import { z } from 'zod';

export const DevSchema = z.object({
  files_created: z.array(z.string()),
  files_modified: z.array(z.string()),
  summary: z.string(),
});

export type DevOutput = z.infer<typeof DevSchema>;
