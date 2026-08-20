/**
 * The ONE domain error-code vocabulary (#587).
 *
 * Fifteen service-local `class XError extends Error` declarations each re-spelled their own
 * subset of this list — six distinct unions of the same six codes
 * (`"NOT_FOUND" | "BAD_REQUEST" | "CONFLICT"`, `… | "FORBIDDEN"`, `… | "INVALID_DATA"`, …).
 * The same shape #614 found in `now` and #604 in the db seam: one concept, N spellings, and
 * no way to tell from a signature whether a code is one the HTTP layer knows.
 *
 * That last part is what made it a bug rather than untidiness. `middleware/error-handler.ts`
 * maps these codes to HTTP STRUCTURALLY — anything not in the map falls through to 500 — so a
 * code invented in a service (or mistyped) silently becomes an internal-server-error instead
 * of the 404/409 it meant. Deriving the middleware's map from this list makes the union and
 * the mapping one thing.
 *
 * Codes that are NOT here are not necessarily wrong: `WorkspaceError` carries its own
 * refusal vocabulary (`STALE_SAFETY_POLICY`, `PROFILE_ALLOWLIST_HOLD`, `NO_AVAILABLE_WORKER`,
 * the `GROUP_MEMBER_*` family) and the middleware handles it in a dedicated `instanceof`
 * branch. The guard suite knows the difference.
 */
export const DOMAIN_ERROR_CODES = [
  "NOT_FOUND",
  "CONFLICT",
  "FORBIDDEN",
  "BAD_REQUEST",
  "VALIDATION_ERROR",
  "INVALID_DATA",
  "INTERNAL",
  "AI_ERROR",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/**
 * The REFUSAL vocabulary (#692): reasons a request is declined that are not themselves HTTP
 * codes. These travel in `WorkspaceError.data.code` while the error's own `code` stays one of
 * NOT_FOUND/BAD_REQUEST/CONFLICT, so the STATUS was always right — what was missing is the
 * reason. `middleware/error-handler.ts` surfaced only `STALE_SAFETY_POLICY`, so every other
 * refusal reached the client as a bare 409 message with no machine-readable code, and the UI
 * and monitor had nothing to branch on.
 *
 * Declared here rather than in the guard suite because the guard used to carry its own copy
 * and EXEMPT these codes on the strength of a prose claim that the middleware handled them —
 * a claim that was false for eight of the nine. Now the middleware reads this list and the
 * guard imports it, so the exemption is a fact about the code instead of a comment.
 */
export const WORKSPACE_REFUSAL_CODES = [
  "STALE_SAFETY_POLICY",
  "PROFILE_ALLOWLIST_HOLD",
  "ISOLATION_REFUSED",
  "OPEN_DIRECT_WORKSPACE",
  "UNSAFE_CODEX_MODEL",
  "GROUP_MEMBER_HAS_WORKSPACE",
  "GROUP_MEMBER_IN_LIVE_GROUP",
  "GROUP_MEMBER_WRONG_PROJECT",
] as const;

export type WorkspaceRefusalCode = (typeof WORKSPACE_REFUSAL_CODES)[number];

/**
 * Refusals that are their OWN error class with a top-level `code`, so they never pass through
 * the `WorkspaceError` branch and are mapped structurally instead.
 *
 * `NO_AVAILABLE_WORKER` is the #692 defect: `WorkerDispatchUnavailableError` declares it as a
 * field INITIALIZER (`readonly code = "NO_AVAILABLE_WORKER"`), which the guard's union regex
 * could not see, and it was absent from every status table — so strict worker dispatch with no
 * live worker produced a silent 500. 503 rather than 409: the request is well-formed and the
 * condition is transient capacity, which is what tells a caller it is worth retrying.
 */
export const STANDALONE_REFUSAL_STATUS = {
  NO_AVAILABLE_WORKER: 503,
} as const satisfies Record<string, number>;


/** Base class for all application-level HTTP errors. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, 404, "NOT_FOUND");
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(message, 403, "FORBIDDEN");
  }
}

/** Thrown when an AI/LLM operation (Claude CLI) fails. */
export class AiOperationError extends AppError {
  constructor(
    message: string,
    public readonly detail?: string,
  ) {
    super(message, 500, "AI_ERROR");
  }
}
