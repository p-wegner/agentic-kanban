/**
 * Request-body schemas for `routes/drive.ts` and `routes/drives.ts` (#806, batches 3 and 4).
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
import { booleanOnly, required, unchecked } from "./body-schema-helpers.js";

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

/**
 * `POST /api/projects/:projectId/drives` (#806, batch 4).
 *
 * The guard lives one hop away, in `drive.service.ts`: `start()`'s FIRST statement is
 * `if (!data.target?.trim()) throw new DriveError("target is required", "BAD_REQUEST")`.
 * Nothing runs before it, so moving the check to the boundary cannot re-order any answer —
 * which is exactly what disqualifies this file's `PUT /:id` (see `parseDriveBody` in the route).
 *
 * `required`, not `requiredTrimmed`: the service trims on the way into the column
 * (`target: data.target.trim()`), so a transform here would be a second trim of the same value.
 *
 * Both nullable fields were never checked and are forwarded with `?? null`, so they stay
 * {@link unchecked} (rule 3). Field order is the declaration order of the body the route read,
 * which is also the only order the single guard could have fired in.
 */
export const startDriveBody = z.object({
  metaIssueId: unchecked<string | null>(),
  target: required("target is required"),
  completionContract: unchecked<string | null>(),
}).passthrough();
