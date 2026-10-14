/** Request-body schema for `routes/project-queue-flush.ts` (#1463). */
import { z } from "zod";

/** `POST /api/projects/:id/queue/flush`. */
export const queueFlushBody = z
  .object({
    dryRun: z.boolean().optional(),
    wait: z.boolean().optional(),
    triggeredBy: z.enum(["manual", "cli"]).optional(),
  })
  .passthrough();
