/**
 * Request-body schemas for `routes/project-rc.ts` (#1239, landed under #806's ratchet).
 *
 * Both routes keep their own semantic guard (`isRcBranch`, and `from !== to`) AFTER the parse,
 * so the schema only pins the wire SHAPE: an optional string per field, with the route's own
 * message. See `./body-schema-helpers.js` for why the predicates are copied, not tightened.
 */
import { z } from "zod";
import { optionalString } from "./body-schema-helpers.js";

/** `POST /api/projects/:id/rc/merge-back`. */
export const rcMergeBackBody = z
  .object({
    branch: optionalString("branch must be a release-candidate branch (rc/<date>[-N])"),
    tag: optionalString("tag must be a string"),
  })
  .passthrough();

/** `POST /api/projects/:id/rc/retarget`. */
export const rcRetargetBody = z
  .object({
    from: optionalString("from and to must be two different release-candidate branches (rc/<date>[-N])"),
    to: optionalString("from and to must be two different release-candidate branches (rc/<date>[-N])"),
  })
  .passthrough();
