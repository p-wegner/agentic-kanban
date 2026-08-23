/**
 * Request-body schemas for `routes/drive.ts` (#806, batch 3).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 *
 * `POST /:projectId/drive/preflight` is NOT here: its `autoRepair` is read as
 * `body.autoRepair === true`, a coercion with no guard — `{ autoRepair: "yes" }` is a valid
 * request today that means "no", and a schema would turn it into a 400.
 */
import { z } from "zod";
import { booleanOnly } from "./body-schema-helpers.js";

/**
 * `PUT /api/projects/:projectId/drive`.
 *
 * The rare guard phrased as a positive type test (`typeof body.enabled !== "boolean"`), so
 * both the missing and the wrong-type case carry the same message — which is what
 * {@link booleanOnly} reproduces.
 */
export const driveEnabledBody = z.object({
  enabled: booleanOnly("enabled (boolean) is required"),
}).passthrough();
