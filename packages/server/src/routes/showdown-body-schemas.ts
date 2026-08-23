/**
 * Request-body schemas for `routes/showdowns.ts` (#806, batch 3).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 */
import { z } from "zod";
import { requiredRaw } from "./body-schema-helpers.js";

/** `POST /api/showdowns/:id/pick-winner`. */
export const pickWinnerBody = z.object({
  winnerWorkspaceId: requiredRaw("winnerWorkspaceId is required"),
}).passthrough();
