/**
 * Request-body schemas for the write routes on `/api/projects` (#806).
 *
 * See `./body-schema-helpers.js` for the three rules that make this swap behaviour-preserving.
 *
 * Two handlers in this file's route are deliberately NOT covered, and both for the same reason
 * — a schema would have to invent messages the endpoint has never said:
 *
 * - **`POST /api/projects/:id/repos`** guards `exactly one of path, cloneUrl, createName`, and
 *   that guard counts a field only when it is `typeof === "string" && .trim()`. Giving those
 *   fields a declared string type would make a `path: 123` answer "expected string" where today
 *   it answers "Provide exactly one of path, cloneUrl, or createName". The cross-field rule and
 *   the per-field types are entangled; untangling them is a contract change, not a swap.
 * - **`POST /api/projects/:id/statuses`** and **`PATCH /api/projects/:id`** have no body guard at
 *   all. `PATCH /:id` in particular forwards the entire body to `updateProject`, and its one
 *   real check (`servicesConfig`) is a 40-line validator answering **422**, not 400 — a
 *   different status, so it cannot move into `parseJsonBody` without changing the contract.
 *
 * Both stay in the countable remainder rather than being quietly half-migrated.
 */
import { z } from "zod";
import {
  requiredRaw,
  optionalString,
  optionalStringOrNull,
  numberOnly,
  unchecked,
} from "./body-schema-helpers.js";

/**
 * The three `POST /api/projects/generate-*-script` endpoints, which share one guard
 * (`if (!body.projectId)`) and therefore one schema.
 */
export const generateScriptBody = z.object({
  projectId: requiredRaw("projectId is required"),
}).passthrough();

/**
 * `PATCH /api/projects/:id/statuses/:statusId`.
 *
 * `numberOnly`, NOT `z.number()`: the guard was `typeof body.sortOrder !== "number"`, which
 * ACCEPTS `NaN`. `z.number()` rejects it, and a body that used to reorder a status (however
 * nonsensically) would start answering 400 — rule 3, and the sharpest instance of it here.
 */
export const updateStatusSortOrderBody = z.object({
  sortOrder: numberOnly("sortOrder must be a number"),
}).passthrough();

/**
 * `PATCH /api/projects/:id/repos/:repoId`.
 *
 * Key order is the guard order — name, setupScript, composeFile — and `composeFile` chains its
 * two guards in the order they ran: the type test, then the newline test. The remaining `name`
 * checks (non-empty after trim, unique among the project's repos) stay in the handler: they need
 * the database, and the uniqueness one answers **409**, not 400.
 */
export const updateProjectRepoBody = z.object({
  name: optionalString("name must be a string"),
  setupScript: optionalStringOrNull("setupScript must be a string or null"),
  composeFile: optionalStringOrNull("composeFile must be a string or null")
    // The guard was `if (body.composeFile && /[\r\n]/…)`, so it never fired for null/undefined.
    .refine((v) => !(v && /[\r\n]/.test(v)), { message: "composeFile must not contain newlines" }),
}).passthrough();

/**
 * `DELETE /api/projects/:id/worktrees`.
 *
 * The guard is cross-field (`!body.path && !body.workspaceId`), so it lives in a `superRefine`
 * that runs after the field checks — matching the original, where `parseJsonBody` had already
 * produced the object before the condition was evaluated. `.passthrough()` matters here: the
 * whole body is forwarded to `removeWorktreeById`.
 */
export const removeWorktreeBody = z.object({
  path: z.string().optional(),
  workspaceId: z.string().optional(),
}).passthrough().superRefine((body, ctx) => {
  if (!body.path && !body.workspaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "path or workspaceId is required" });
  }
});

/** `POST /api/projects/:id/worktrees/open`. */
export const openWorktreeBody = z.object({
  path: requiredRaw("path is required"),
}).passthrough();

/**
 * `POST /api/projects/:id/onboarding/apply`.
 *
 * `input` is a `Record<string, unknown>` handed straight to the step applier; `z.record()` would
 * reject an array, which `typeof x === "object"` accepted — so it carries its declared type and
 * no predicate (rule 3).
 */
export const onboardingApplyBody = z.object({
  stepId: requiredRaw("stepId is required"),
  input: unchecked<Record<string, unknown>>(),
}).passthrough();

/** `POST /api/projects/:id/onboarding/skip`. */
export const onboardingSkipBody = z.object({
  stepId: requiredRaw("stepId is required"),
}).passthrough();
