/**
 * Request-body schemas for the write actions on `/api/workspaces/:id` (#806).
 *
 * See `./body-schema-helpers.js` for the three rules that make this swap behaviour-preserving.
 *
 * Every schema here is `.passthrough()`, and for `createWorkspaceCommentBody` that is
 * load-bearing rather than defensive: the handler forwards the WHOLE body
 * (`workspaceService.createComment(id, body)`), so a bare `z.object()` would strip any key the
 * schema does not name and the service would silently start receiving less than it does today.
 *
 * Only the handlers that ALREADY had a guard are here. The `parseOptionalJsonBody` actions
 * (`/launch`, `/implement-plan`, `/bisect`, `/reconcile-as-done`, `/fix-and-merge`) are not:
 * that helper answers `{}` for a missing or malformed body by design, so routing it through a
 * schema would turn "no body" into a 400 for endpoints whose entire contract is that the body
 * is optional.
 */
import { z } from "zod";
import { requiredRaw, unchecked } from "./body-schema-helpers.js";

/** `POST /api/workspaces/:id/turn` — the follow-up prompt. Bare falsy guard, so no trim test. */
export const workspaceTurnBody = z.object({
  content: requiredRaw("content is required"),
}).passthrough();

/** `POST /api/workspaces/:id/reject-plan`. */
export const rejectPlanBody = z.object({
  feedback: requiredRaw("feedback is required"),
}).passthrough();

/**
 * `POST /api/workspaces/:id/comments`.
 *
 * One combined message on both fields, because the guard was one condition
 * (`!body.filePath || !body.body`). The line numbers and `side` never had a guard and the
 * service reads them off the forwarded body, so they carry their declared types only.
 */
export const createWorkspaceCommentBody = z.object({
  filePath: requiredRaw("filePath and body are required"),
  body: requiredRaw("filePath and body are required"),
  lineNumOld: unchecked<number | null>(),
  lineNumNew: unchecked<number | null>(),
  side: unchecked<string>(),
}).passthrough();

/** `PATCH /api/workspaces/:id/comments/:commentId`. */
export const updateWorkspaceCommentBody = z.object({
  body: requiredRaw("body is required"),
}).passthrough();

/**
 * `PATCH /api/workspaces/:id/comments/:commentId/resolve`.
 *
 * `z.boolean()` IS `typeof v === "boolean"` exactly — unlike `z.number()` vs
 * `typeof v === "number"` — so it copies the guard rather than tightening it. Both error slots
 * carry the guard's single message, since the guard could not distinguish a missing `resolved`
 * from a non-boolean one.
 */
export const resolveWorkspaceCommentBody = z.object({
  resolved: z.boolean({
    required_error: "resolved (boolean) is required",
    invalid_type_error: "resolved (boolean) is required",
  }),
}).passthrough();
