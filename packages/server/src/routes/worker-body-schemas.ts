/** Request-body schema for `PUT /api/workers/:id/settings` (#1381). Field-level checks live in `parseWorkerSettings`. */
import { z } from "zod";

export const workerSettingsBody = z.object({
  settings: z.record(z.string(), z.unknown()).default({}),
});
