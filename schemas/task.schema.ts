import { z } from 'zod';

export const TaskItemSchema = z.object({
  description: z.string(),
  priority: z.string(),
  dependencies: z.array(z.string()),
});

export const TaskSchema = z.object({
  tasks: z.array(TaskItemSchema),
});

export type TaskOutput = z.infer<typeof TaskSchema>;
