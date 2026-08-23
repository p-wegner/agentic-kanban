/**
 * Request-body schemas for `routes/merge-queue.ts` (#806, batch 3).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 */
import { z } from "zod";
import { arrayOnly, unchecked } from "./body-schema-helpers.js";

/**
 * `POST /api/merge-queue`.
 *
 * `dryRun` and `skipOnConflict` keep no predicate: both are read as truthiness
 * (`if (body.dryRun)`), so a non-boolean is a meaningful request today, not an error.
 */
export const mergeQueueBody = z.object({
  workspaceIds: arrayOnly<string>(
    "workspaceIds is required and must be a non-empty array",
    (v) => v.length > 0,
  ),
  dryRun: unchecked<boolean>(),
  skipOnConflict: unchecked<boolean>(),
}).passthrough();
