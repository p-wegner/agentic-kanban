/**
 * Request-body schemas for `routes/project-analytics.ts` (#806, batch 3).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 */
import { z } from "zod";
import { arrayOnly } from "./body-schema-helpers.js";

/** `POST /api/projects/:id/check-overlap`. One combined guard, therefore one message. */
export const checkOverlapBody = z.object({
  issueIds: arrayOnly<string>("issueIds array is required", (v) => v.length > 0),
}).passthrough();
