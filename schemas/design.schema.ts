import { z } from 'zod';

export const DesignSchema = z.object({
  architecture: z.string(),
  tech_stack: z.array(z.string()),
  file_structure: z.record(z.string(), z.unknown()),
  assumptions: z.array(z.string()),
});

export type DesignOutput = z.infer<typeof DesignSchema>;
