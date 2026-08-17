/**
 * Request-body schemas for the `/api/issues` POST/PATCH routes (#512).
 *
 * These replace a ladder of hand-written `if (!body.x) return c.json({ error: "..." }, 400)`
 * guards. Three rules kept the swap behaviour-preserving rather than merely tidy:
 *
 * 1. **The messages are copied verbatim**, not regenerated. `domainErrorHandler` renders an
 *    HTTPException as `{ error: message }` with its status, so the wire shape already
 *    matched — the only thing that could drift was the TEXT, and zod's defaults
 *    ("Required", "Expected string, received number") are not what these endpoints have
 *    always said.
 * 2. **Field order matches the old guard order.** Only the FIRST issue is reported (the
 *    guards were early returns), and zod walks an object schema in key order, so a
 *    reordered schema would silently change which message a caller sees.
 * 3. **The predicates are copied too, not tightened.** `Array.isArray` stays
 *    `Array.isArray` — validating element shape here would reject bodies these routes
 *    accept today, which is a contract change, not a refactor.
 *
 * The one deliberate tightening: fields the routes DECLARED as `string` but never checked
 * (`description`, `mergedDescription`, …) are now `z.string().optional()`, so a request
 * sending a number gets a 400 instead of having it passed downstream. That matches the
 * type the route already claimed.
 */
import { z } from "zod";

/** A required, non-blank string carrying the guard's exact message. */
function required(message: string) {
  return z
    .string({ required_error: message, invalid_type_error: message })
    // `.refine`, not `.trim()`: the guards tested `!body.x?.trim()` but passed the
    // ORIGINAL value on, so trimming here would change what the service receives.
    .refine((v) => v.trim().length > 0, message);
}

/** A present, non-blank string with no trim test (the guard was a bare falsy check). */
function requiredRaw(message: string) {
  return z.string({ required_error: message, invalid_type_error: message }).min(1, message);
}

/**
 * `Array.isArray` and nothing more, preserving the element type the route declared.
 * Deliberately NOT `z.array(elementSchema)` — see rule 3 above.
 */
function arrayOnly<T>(message: string, extra?: (v: unknown[]) => boolean) {
  return z.custom<T[]>((v) => Array.isArray(v) && (extra ? extra(v) : true), { message });
}

export const enhanceIssueBody = z.object({
  title: required("title is required"),
  description: z.string().optional(),
  projectId: z.string().optional(),
});

export const analyzeDependenciesBody = z.object({
  // One combined message for either field, because the guard was a single
  // `if (!body.issueId || !body.projectId)` — splitting it into two per-field messages
  // would change what a caller missing only `projectId` is told.
  issueId: requiredRaw("issueId and projectId are required"),
  projectId: requiredRaw("issueId and projectId are required"),
});

export const aiEstimateBody = z.object({
  issueId: requiredRaw("issueId is required"),
});

export const projectIdBody = z.object({
  projectId: requiredRaw("projectId is required"),
});

export const decomposeConfirmBody = z.object({
  projectId: requiredRaw("projectId is required"),
  children: arrayOnly<unknown>("children must be an array"),
  dependencies: arrayOnly<unknown>("dependencies must be an array"),
  driveTarget: z.string().optional(),
});

export const contractConfirmBody = z.object({
  projectId: requiredRaw("projectId is required"),
  survivorId: requiredRaw("survivorId is required"),
  memberIds: arrayOnly<string>("memberIds must be an array of at least 2 ids", (v) => v.length >= 2),
  mergedTitle: required("mergedTitle is required"),
  mergedDescription: z.string().optional(),
});

export const batchIssuesBody = z.object({
  projectId: requiredRaw("projectId is required"),
  issues: arrayOnly<unknown>("issues must be an array"),
  parentIssueId: z.string().optional(),
  driveTarget: z.string().optional(),
  dependencies: arrayOnly<unknown>("dependencies must be an array").optional(),
});

export const dependenciesBatchBody = z.object({
  edges: arrayOnly<unknown>("edges must be an array"),
});

export const contractCoupledBody = z.object({
  issueIds: arrayOnly<string>("issueIds must be a non-empty array", (v) => v.length > 0),
  leadIssueId: z.string().optional(),
});

export const bulkUpdateBody = z.object({
  issueIds: arrayOnly<string>("issueIds must be a non-empty array", (v) => v.length > 0),
  // `typeof x === "object"` is true for arrays, and the original guard accepted them —
  // `z.record()` would not, so the predicate is copied rather than improved.
  updates: z.custom<Record<string, unknown>>(
    (v) => !!v && typeof v === "object",
    { message: "updates is required" },
  ),
});
