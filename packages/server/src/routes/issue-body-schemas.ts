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
// The `required` / `requiredRaw` / `arrayOnly` predicates, and the three rules that make a
// guard-to-schema swap behaviour-preserving, now live in the shared vocabulary every
// `*-body-schemas.ts` is written against (#806). They are unchanged — only relocated, so the
// second schema file did not have to copy them.
import { required, requiredRaw, arrayOnly, unchecked } from "./body-schema-helpers.js";
import type { ShowdownContestant } from "@agentic-kanban/shared";
import type { IssueCommentKind, IssueCommentAuthor } from "../repositories/issue-comments.repository.js";
import type { PreflightClarification } from "../services/ticket-preflight.service.js";

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

export const groupScanBody = z.object({
  projectId: requiredRaw("projectId is required"),
  apply: z.boolean().optional(),
  // #918: "touched-files" is the deterministic (no LLM call) seed over `touchedFilesJson`;
  // default "llm" keeps the existing AI-consolidation behaviour unchanged.
  mode: z.enum(["llm", "touched-files"]).optional(),
  minSharedFiles: z.number().int().positive().optional(),
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

/* ------------------------------------------------------------------------------------------
 * #806 batch 3 — the rest of `/api/issues`.
 *
 * Everything below is `.passthrough()`, which the #512 schemas above predate: a bare
 * `z.object()` STRIPS unknown keys from `result.data`, so any handler forwarding the whole
 * body onward (`addArtifact(issueId, body)`) would silently start receiving fewer fields.
 * The #512 schemas' missing `.passthrough()` is a separate, disclosed finding — none of them
 * forwards a whole body today, so it is latent rather than live.
 *
 * Two handlers in this file are REJECTED rather than deferred; the argument is in the
 * ratchet's entry for `issues.ts`.
 * ---------------------------------------------------------------------------------------- */

/**
 * `POST /api/issues/archive-done`.
 *
 * Only `projectId` gets a predicate. `olderThanDays` is COERCED, not checked — the handler
 * runs `Number(body.olderThanDays)` and then `Number.isFinite(days) && days > 0`, so the
 * string `"30"` is a valid request today. A `z.number()` here would 400 it. The coercion test
 * therefore stays in the handler, where it can keep accepting what it accepts.
 */
export const archiveDoneBody = z.object({
  projectId: requiredRaw("projectId is required"),
  olderThanDays: unchecked<number>(),
  nowOverride: unchecked<string>(),
}).passthrough();

/**
 * `POST /api/issues`.
 *
 * `projectId` then `title`, in the order the two guards ran. `title` uses {@link required}
 * (not `requiredTrimmed`): the guard tested `body.title?.trim()` but passed the ORIGINAL
 * value to `createIssue`, and trimming here would change what the service stores.
 *
 * Every other field keeps its declared type and NO predicate. They were never checked, and
 * #512's sanctioned declared-type tightening is optional — taking it here would 400 requests
 * that succeed today (`estimate: 5`, `sortOrder: "3"`), which is the one thing the swap rule
 * forbids. The declared type is documentation; the guard never enforced it and neither does
 * this.
 */
export const createIssueBody = z.object({
  projectId: requiredRaw("projectId is required"),
  title: required("title is required"),
  description: unchecked<string>(),
  priority: unchecked<string>(),
  issueType: unchecked<string>(),
  skipAutoReview: unchecked<boolean>(),
  estimate: unchecked<string | null>(),
  sortOrder: unchecked<number>(),
  statusId: unchecked<string>(),
  workflowTemplateId: unchecked<string | null>(),
  externalKey: unchecked<string | null>(),
  externalUrl: unchecked<string | null>(),
  reposTouched: unchecked<string[]>(),
}).passthrough();

/**
 * `POST /api/issues/:id/analyze-touched-files`.
 *
 * The call site is `parseJsonBody(...).catch(() => ({ refresh: false }))`, so a rejection here
 * never reaches the client — and that is exactly why the check is safe: the handler's only use
 * is `body?.refresh === true`, so a non-boolean produced `false` before and produces `false`
 * now, by the catch instead of by the comparison. Nothing observable moves; the body is
 * nevertheless checked rather than asserted.
 */
export const analyzeTouchedFilesBody = z.object({
  refresh: z.custom<boolean>((v) => typeof v === "boolean", { message: "refresh must be a boolean" }).optional(),
}).passthrough();

/** `POST /api/issues/:id/preflight`. `clarifications` was never checked and keeps its type. */
export const preflightBody = z.object({
  projectId: requiredRaw("projectId is required"),
  clarifications: unchecked<PreflightClarification[]>(),
}).passthrough();

/**
 * `PUT /api/issues/:id/repos-touched`.
 *
 * `Array.isArray` and nothing more — the route drops unknown repo names itself and echoes the
 * applied set back, so element validation here would refuse a request the endpoint is designed
 * to accept partially.
 */
export const reposTouchedBody = z.object({
  reposTouched: arrayOnly<string>("reposTouched (array) is required"),
}).passthrough();

/** `POST /api/issues/:id/tags`. */
export const issueTagBody = z.object({
  tagId: requiredRaw("tagId is required"),
}).passthrough();

/** `POST /api/issues/:id/dependencies`. `type` was never checked; the service defaults it. */
export const issueDependencyBody = z.object({
  dependsOnId: requiredRaw("dependsOnId is required"),
  type: unchecked<string>(),
}).passthrough();

/**
 * `POST /api/issues/:id/artifacts`.
 *
 * `type` and `content` share ONE message because the guard was a single
 * `if (!body.type || !body.content)` — splitting it would change what a caller missing only
 * `content` is told. The whole body is handed to `addArtifact`, hence `.passthrough()`.
 */
export const issueArtifactBody = z.object({
  type: requiredRaw("type and content are required"),
  mimeType: unchecked<string>(),
  content: requiredRaw("type and content are required"),
  caption: unchecked<string>(),
  workspaceId: unchecked<string>(),
}).passthrough();

/**
 * `POST /api/issues/:id/comments`.
 *
 * `body` is {@link required}, not `requiredTrimmed`: the guard tested the trimmed value and
 * stored the original. `kind` and `author` keep no predicate — the handler runs them through
 * its own deliberate whitelists and FALLS BACK to `"note"` / `"user"` rather than rejecting,
 * so a schema enum would turn an accepted request into a 400.
 */
export const issueCommentBody = z.object({
  kind: unchecked<IssueCommentKind>(),
  author: unchecked<IssueCommentAuthor>(),
  body: required("body is required"),
  payload: unchecked<unknown>(),
  workspaceId: unchecked<string>(),
}).passthrough();

/** `POST /api/issues/:id/showdown`. One combined guard, therefore one combined message. */
export const showdownBody = z.object({
  contestants: arrayOnly<ShowdownContestant>(
    "contestants must be an array with at least 2 entries",
    (v) => v.length >= 2,
  ),
}).passthrough();
