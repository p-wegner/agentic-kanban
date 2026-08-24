/**
 * Request-body schemas for the write routes on `/api/projects` (#806).
 *
 * See `./body-schema-helpers.js` for the three rules that make this swap behaviour-preserving.
 *
 * **Batch 2 (#806) resolved two of the three handlers batch 1 deferred**, and the resolution is
 * worth recording because the deferral's reasoning was sound but its conclusion was too strong:
 *
 * - **`POST /api/projects/:id/repos`** — batch 1 read the cross-field rule and the per-field
 *   types as entangled, and they ARE. The way out is not to untangle them but to decline the
 *   per-field types entirely: the fields keep `unchecked` (no predicate at all, rule 3), and the
 *   whole guard moves into a `superRefine`, which zod runs AFTER the field checks. With no field
 *   check to fire first, `path: 123` still answers "Provide exactly one of path, cloneUrl, or
 *   createName", exactly as today. See {@link addProjectRepoBody}.
 * - **`POST /api/projects/:id/statuses`** — no guard, but the fields ARE declared (`name: string`,
 *   `sortOrder?: number`), so the sanctioned declared-type tightening covers it. See
 *   {@link addStatusBody}.
 *
 * **`PATCH /api/projects/:id` stays unconverted, and now with a stronger reason than "no guard".**
 * Its body has no declared type at all (`parseJsonBody(c)`, i.e. `Record<string, unknown>`) and
 * is forwarded WHOLE to `updateProject`, so there is nothing to tighten TO — a schema there would
 * either invent a field list the endpoint has never enforced, or validate nothing and merely look
 * validated. Its one real check (`servicesConfig`, a 40-line validator) answers **422**, not 400,
 * so it cannot move into `parseJsonBody` at all. It stays in the countable remainder.
 *
 * **`POST /api/projects/create` converted in batch 5, and batch 2's reason for skipping it did
 * not survive an audit.** That reason — "their optional string fields have no observed null
 * discipline" — is about the OPTIONAL fields, and it is still correct about them; every one of
 * them stays {@link unchecked} here. It never addressed `name`, which is REQUIRED, and whose
 * guard is the first statement of `createProject` (`const name = body.name.trim(); if (!name)
 * throw ProjectError("name is required", "BAD_REQUEST")`) — batch 4's own conversion criterion.
 * `{}` reaches `undefined.trim()` and answers **500** today; it now answers the 400 the
 * endpoint already gives a blank name. See {@link createProjectBody}.
 *
 * **`POST /api/projects` stays, with a sharper reason than batch 2 gave it.** Two things block
 * it, and neither is about optional fields. Its guard is a CROSS-FIELD rule
 * ("repoPath or cloneUrl is required" / "…not both") that lives inside `registerProjectTracked`
 * — which `registerProject` calls only AFTER `startRegistrationProgress(body.progressId)` has
 * created the progress record the caller polls via
 * `GET /api/projects/registration-progress/:id`. A schema at the boundary would leave that
 * record uncreated, so a poller would get 404 "No such registration in progress" where it gets
 * a failed record today. And `{ repoPath: 7 }` is truthy, so it passes the cross-field rule and
 * fails later as `"Invalid repo: …"` — a different 400 message than any type check would give.
 */
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  required,
  requiredRaw,
  optionalString,
  optionalStringOrNull,
  numberOnly,
  stringOnly,
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

/**
 * `POST /api/projects/:id/statuses` (#806, batch 2).
 *
 * The handler never guarded either field, so this is the sanctioned declared-type tightening and
 * nothing more. Two knowing consequences, both on requests that cannot succeed today:
 *   - a missing `name` reaches `body.name` as `undefined` and hits a NOT NULL column, i.e. a 500;
 *     it is now a 400 carrying the message the sibling service guard already uses.
 *   - `stringOnly`, NOT `requiredRaw`: `name: ""` is accepted by the column and by this endpoint
 *     today, and `.min(1)` would start refusing it — a live request turned into a 400.
 */
export const addStatusBody = z.object({
  name: stringOnly("name is required"),
  sortOrder: numberOnly("sortOrder must be a number").optional(),
}).passthrough();

/**
 * `POST /api/projects/:id/repos` (#806, batch 2) — the "exactly one of" mode guard.
 *
 * Every field is `unchecked` ON PURPOSE, and that is what makes the swap exact. The guard counts
 * a mode field only when it is `typeof === "string" && .trim()`, so a `path: 123` is not an
 * "expected string" error, it is a body that named ZERO modes — and the message it gets says so.
 * Giving the fields their declared types would fire first and change that answer, which is the
 * entanglement batch 1 correctly identified. A `superRefine` runs after the (absent) field checks
 * and reproduces the ladder in its original order: mode count first, then the absolute-path test,
 * which the original never reached when the mode count was wrong — hence `else if`.
 *
 * The rest of the ladder (clone failure, repo detection, duplicate-repo 409) stays in the
 * handler: it needs the filesystem and the database, and two of its answers are not 400.
 */
export const addProjectRepoBody = z.object({
  path: unchecked<string>(),
  cloneUrl: unchecked<string>(),
  createName: unchecked<string>(),
  name: unchecked<string>(),
  generateReadme: unchecked<boolean>(),
  setupScript: unchecked<string | null>(),
  composeFile: unchecked<string | null>(),
}).passthrough().superRefine((body, ctx) => {
  const modeCount = [body.path, body.cloneUrl, body.createName]
    .filter((v) => typeof v === "string" && v.trim()).length;
  if (modeCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one of path, cloneUrl, or createName",
    });
  } else if (body.path && !isAbsolute(body.path)) {
    // A relative `path` would otherwise be resolved against the SERVER's CWD by detectRepoInfo,
    // yielding a misleading "not a git repository: <server-dir>/<fragment>" error (#68).
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "repo path must be an absolute path" });
  }
});

/**
 * `POST /api/projects/create`.
 *
 * `required`, because the guard tested the TRIMMED value and a whitespace-only name answers
 * "name is required" today. The ORIGINAL value is forwarded — `createProject` trims it itself.
 *
 * Everything else stays {@link unchecked}, which is the whole reason this conversion is safe:
 * batch 2 declined the file on the optional fields' null discipline, and declining to check
 * them keeps that concern intact while still moving the one guard that exists.
 */
export const createProjectBody = z.object({
  name: required("name is required"),
  path: unchecked<string>(),
  description: unchecked<string>(),
  color: unchecked<string>(),
  gitignoreTemplate: unchecked<string>(),
  generateReadme: unchecked<boolean>(),
}).passthrough();
