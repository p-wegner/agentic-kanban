import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppError, AiOperationError, type DomainErrorCode } from "../errors/index.js";
import { WorkspaceError } from "../services/workspace-internals.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

type StatusCode = 400 | 403 | 404 | 409 | 500 | 503;

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
  INVALID_DATA: 400,
  INTERNAL: 500,
  AI_ERROR: 500,
};

function domainCodeStatus(err: unknown): StatusCode | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    // The narrowing is the point: an arbitrary string is NOT a DomainErrorCode, and the
    // `in` check is what proves it is one before the lookup.
    if (typeof code === "string" && code in DOMAIN_CODE_STATUS) {
      return DOMAIN_CODE_STATUS[code as DomainErrorCode];
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
  }

  if (err instanceof AppError) {
    return c.json({ error: err.message }, err.statusCode as StatusCode);
  }

  // Any error carrying a recognized domain code — every service-local *Error class,
  // registered or not — maps here, once.
  const status = domainCodeStatus(err);
  if (status) {
    // #510: batch routes report WHICH entry failed. That field was the only reason those
    // routes kept hand-written try/catch blocks, so it is emitted here — omitted entirely
    // when absent, leaving every single-item response shape unchanged.
    const index = (err as { index?: unknown }).index;
    return c.json(
      { error: err.message, ...(typeof index === "number" ? { index } : {}) },
      status,
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
