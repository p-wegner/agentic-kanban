import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  AppError,
  AiOperationError,
  STANDALONE_REFUSAL_STATUS,
  WORKSPACE_REFUSAL_CODES,
  type DomainErrorCode,
} from "../errors/index.js";
import { WorkspaceError } from "../services/workspace-internals.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

type StatusCode = 400 | 403 | 404 | 409 | 422 | 500 | 503;

/**
 * The shared domain error-code vocabulary → HTTP status, mapped in ONE place.
 *
 * Every service-local `XxxError extends Error` carries one of these as a string
 * `code` (IssueError, ProjectError, DriveError, TagError, MilestoneError, …). By
 * mapping STRUCTURALLY on `code` rather than maintaining an explicit per-class
 * `instanceof` union, a new domain-error class is handled automatically and can
 * never silently fall through to a generic 500 (the bug that left DriveError,
 * MilestoneError, etc. unmapped). It also decouples this middleware from importing
 * a dozen service modules.
 *
 * Node system errors (ENOENT, ECONNRESET, …) carry codes that are NOT in this set,
 * so they correctly fall through to 500 instead of being mistaken for domain errors.
 */
// #587 — keyed by `DomainErrorCode`, so the union in `errors/` and this mapping cannot
// drift: adding a code without a status (or a status without a code) is a type error.
const DOMAIN_CODE_STATUS: Record<DomainErrorCode, StatusCode> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  FORBIDDEN: 403,
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 400,
  UNPROCESSABLE: 422,
  INVALID_DATA: 400,
  INTERNAL: 500,
  AI_ERROR: 500,
};

function domainCodeStatus(err: unknown): { code: DomainErrorCode; status: StatusCode } | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    // The narrowing is the point: an arbitrary string is NOT a DomainErrorCode, and the
    // `in` check is what proves it is one before the lookup.
    if (typeof code === "string" && code in DOMAIN_CODE_STATUS) {
      // #823 — the CODE is returned alongside the status because the body needs it too.
      // Returning only the status is what made the recognised code unrecoverable at the
      // call site, so the generic branch could not echo it even though it had proved it.
      return { code: code as DomainErrorCode, status: DOMAIN_CODE_STATUS[code as DomainErrorCode] };
    }
  }
  return null;
}

export function domainErrorHandler(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }

  if (err instanceof AiOperationError) {
    return c.json({ error: err.message, ...(err.detail ? { detail: err.detail } : {}) }, 500);
  }

  // WorkspaceError carries structured merge / stale-safety payloads that drive the
  // merge endpoint's response contract. Handle those bespoke shapes first; a plain
  // WorkspaceError (no special data) still falls through to the generic code mapping.
  if (err instanceof WorkspaceError) {
    if (err.data?.mergeReason) {
      const reason = err.data.mergeReason as string;
      const body: Record<string, unknown> = { reason, message: err.message };
      if (err.data.conflictFiles) body.conflictFiles = err.data.conflictFiles;
      if (err.data.uncommittedFiles) body.blockingFiles = err.data.uncommittedFiles;
      // Stale-build errors are service-unavailable (503), not merge conflicts (409).
      const status: StatusCode = reason === "server_build_stale" ? 503 : 409;
      return c.json(body, status);
    }
    if (err.data?.code === "STALE_SAFETY_POLICY") {
      return c.json(
        { error: err.message, code: "STALE_SAFETY_POLICY", staleFiles: err.data.staleFiles ?? [] },
        409,
      );
    }
    // #692 — every OTHER refusal reason was dropped here. The status was already right (it
    // comes from the error's own NOT_FOUND/BAD_REQUEST/CONFLICT code), but the body carried
    // only a prose message, so a client could not tell a profile-allowlist hold from an
    // isolation refusal from a group-member conflict without string-matching the sentence.
    // The guard suite exempted these codes from the HTTP vocabulary on the claim that this
    // branch handled them; it did not. Now it does, and the guard checks it.
    const refusal = err.data?.code;
    if (typeof refusal === "string" && (WORKSPACE_REFUSAL_CODES as readonly string[]).includes(refusal)) {
      const status = DOMAIN_CODE_STATUS[err.code];
      return c.json({ error: err.message, code: refusal }, status);
    }
  }

  // A refusal that is its own error class with a top-level `code`, so it never reaches the
  // WorkspaceError branch above and is absent from DOMAIN_CODE_STATUS (#692). Without this,
  // `WorkerDispatchUnavailableError` — strict worker dispatch with no live worker — fell all
  // the way through to the generic 500 below, which is exactly the "unknown code is a silent
  // 500" defect the #587 vocabulary exists to prevent.
  const standalone = (err as { code?: unknown }).code;
  if (typeof standalone === "string" && standalone in STANDALONE_REFUSAL_STATUS) {
    const status = STANDALONE_REFUSAL_STATUS[standalone as keyof typeof STANDALONE_REFUSAL_STATUS];
    return c.json({ error: err.message, code: standalone }, status as StatusCode);
  }

  // #823 — `code` is echoed here for the same reason as in the generic branch below:
  // `AppError` has always CARRIED a code (`NotFoundError` -> "NOT_FOUND", `ConflictError`
  // -> "CONFLICT", …) and the body dropped it, so a client could only recover the reason
  // by string-matching the prose message or re-deriving it from the status — which is
  // lossy (400 is VALIDATION_ERROR, BAD_REQUEST or INVALID_DATA).
  if (err instanceof AppError) {
    return c.json({ error: err.message, code: err.code }, err.statusCode as StatusCode);
  }

  // Any error carrying a recognized domain code — every service-local *Error class,
  // registered or not — maps here, once.
  const domain = domainCodeStatus(err);
  if (domain) {
    // #510: batch routes report WHICH entry failed. That field was the only reason those
    // routes kept hand-written try/catch blocks, so it is emitted here — omitted entirely
    // when absent, leaving every single-item response shape unchanged.
    const index = (err as { index?: unknown }).index;
    // #823 — echo the code that decided the status. Without it this branch answered a
    // machine-readable refusal with prose only: `POST /api/workspaces/:id/review` measured
    // `404 {"error":"Workspace not found"}` here against `404 {"error":"Workspace not
    // found","code":"NOT_FOUND"}` from the route's own inline body, which is why the three
    // inline review bodies could not be converted onto this mapper (#821). The code is the
    // one already PROVEN to be in `DOMAIN_CODE_STATUS`, never an arbitrary `err.code`, so a
    // Node system error (ENOENT) still cannot leak its code into a response body.
    return c.json(
      { error: err.message, code: domain.code, ...(typeof index === "number" ? { index } : {}) },
      domain.status,
    );
  }

  // Defensive: a legacy ad-hoc throw that set only a numeric statusCode.
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number") {
    return c.json({ error: err.message }, statusCode as StatusCode);
  }

  console.error("[server] unhandled error:", err);
  return c.json({ error: errorMessage(err) }, 500);
}
