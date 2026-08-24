/**
 * Request-body schemas for `routes/milestones.ts` (#806, batch 4).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 *
 * **The guard this copies lives one hop away, in `milestone.service.ts`** — `create` throws
 * `MilestoneError("name is required", "BAD_REQUEST")` as its FIRST statement. That is not a
 * reason to leave the route unvalidated (the body is still read untrusted at the boundary), but it IS the reason
 * the route wraps the rejection: `domainErrorHandler` renders a coded domain error as
 * `{ error, code: "BAD_REQUEST" }`, and `parseJsonBody`'s bare `HTTPException` renders
 * `{ error }` — so an unwrapped swap would drop a field. See `parseMilestoneBody` in the route.
 *
 * The service keeps its guards: it is called by more than the route, and a check at the
 * boundary does not make the one inside the domain redundant.
 */
import { z } from "zod";
import { required, unchecked } from "./body-schema-helpers.js";

/**
 * `POST /api/projects/:projectId/milestones`.
 *
 * `required`, not `requiredTrimmed`: the SERVICE trims (`createMilestone({ name: data.name.trim() })`),
 * so transforming here as well would be a second trim of an already-trimmed value — harmless
 * but a lie about where the trim happens. The predicate is the same either way.
 *
 * `dueDate` is `string | null | undefined` and was never checked — it goes straight into the
 * column via `data.dueDate ?? null` — so it stays {@link unchecked} (rule 3).
 */
export const createMilestoneBody = z.object({
  name: required("name is required"),
  dueDate: unchecked<string | null>(),
}).passthrough();

/*
 * `PUT /api/projects/:projectId/milestones/:id` is deliberately NOT here, and the reason is a
 * new one worth naming: **ORDER**. Its `name cannot be empty` guard runs AFTER the service has
 * looked the milestone up and checked its project — so today a blank name on a milestone that
 * does not exist answers 404 "Milestone not found", and on one belonging to another project it
 * answers 403. A schema runs BEFORE the handler, so all three of those become 400 "name cannot
 * be empty". Hardening the body must not re-order the answers a caller already gets, so the
 * read stays in the census. The same argument covers `drives.ts PUT /:id`, `tags.ts PATCH /:id`,
 * `project-scripts.ts`, `scheduled-runs.ts PUT /:id` and `quality-metrics.ts POST`.
 */
