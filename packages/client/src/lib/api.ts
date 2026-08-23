import { ApiContractError, API_RESPONSE_SCHEMA_COUNT, parseApiResponse } from "./apiResponseSchemas.js";

export { ApiContractError, API_RESPONSE_SCHEMA_COUNT };

// ───────────────────────── The wire boundary (#780) ─────────────────────────
//
// This module is the ONE place every client API call passes through, and it used to end in
//
//     return res.json() as Promise<T>;
//
// `as T` is an assertion, not a check. The client and server agree on ~75 DTOs shared
// through `@agentic-kanban/shared`, but `types/api.ts` is `export type *` — erased before
// either process starts — so nothing checked that they still agreed: not at build time in a
// way that could fail, not at runtime, and not in CI. A renamed or dropped field produced
// the wrong shape with full type-system confidence, and the failure surfaced later and
// elsewhere as an `undefined` inside a component.
//
// Now the body is PARSED. Two ways in, deliberately:
//
//  1. A registry keyed by method + path template (`./apiResponseSchemas.ts`, which also
//     explains why it lives here and not in `shared/lib`). Because every caller already
//     funnels through here, registering an endpoint validates all of its existing call
//     sites at once — no migration of ~200 call sites, and a new caller is covered the day
//     it is written. Today it covers the mutating endpoints of issues, workspaces and
//     projects (see that module for the exact list and why it is partial).
//  2. An explicit per-call `schema`, for a caller that wants to pin a response the registry
//     does not cover yet. It wins over the registry when both apply.
//
// Anything else goes through `unvalidatedResponse` below — one named, greppable seam
// instead of an invisible cast at every call site. THAT is the remaining hole, and it is
// the thing to count when asking how far #780 got.

/** A per-call response parser. `zod`'s `ZodType` satisfies this structurally. */
export interface ResponseSchema<T> {
  parse(value: unknown): T;
}

/**
 * Two seams, both named, because the difference between them is the whole point of #780:
 *
 *  - `validatedResponse` — the body was CHECKED against the schema registered for this
 *    endpoint and matched. The generic is then a description of something already verified.
 *  - `unvalidatedResponse` — no schema is registered, so the shape is still only the
 *    caller's `T` and nothing has confirmed it. This is the remaining hole.
 *
 * `res.json() as T` was neither: it could not be found, counted, or removed, and it made
 * "verified" and "asserted" the same expression. Do not add call sites for the second one;
 * add an entry to `API_RESPONSE_SCHEMAS` instead.
 */
function validatedResponse<T>(value: unknown): T {
  return value as T;
}

function unvalidatedResponse<T>(value: unknown): T {
  return value as T;
}

function methodOf(init?: RequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

/**
 * Validate one decoded response body. Throws `ApiContractError` when a registered schema
 * rejects it, so a wrong shape fails HERE — at the boundary, naming the endpoint — instead
 * of somewhere downstream as a missing property.
 */
function validateResponse<T>(method: string, path: string, body: unknown, schema?: ResponseSchema<T>): T {
  if (schema) return schema.parse(body);
  // Throws ApiContractError when a registered schema rejects the body.
  const outcome = parseApiResponse(method, path, body);
  return outcome.validated ? validatedResponse<T>(body) : unvalidatedResponse<T>(body);
}

/** Shared non-OK handling — identical for plain and conditional GETs (#519). */
async function throwApiError(res: Response): Promise<never> {
  let message = `API error: ${res.status} ${res.statusText}`;
  let body: unknown;
  try {
    body = await res.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    // response body wasn't JSON, use default message
  }
  throw Object.assign(new Error(message), { body, status: res.status, statusText: res.statusText });
}

export async function apiFetch<T>(path: string, init?: RequestInit, schema?: ResponseSchema<T>): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) await throwApiError(res);
  const body: unknown = await res.json();
  return validateResponse<T>(methodOf(init), path, body, schema);
}

// ───────────────────────── Conditional (ETag / 304) GET ─────────────────────────
//
// Three call sites hand-rolled this (#519): board columns, the agent live ticker, and
// the session transcript panel. Each had its own ETag store, header building and 304
// branch — and each handled a NON-OK response differently: one re-implemented
// `apiFetch`'s `body.error` extraction, one swallowed it as `null`, one threw a bare
// `HTTP <n>`. So the same server error surfaced three different ways depending on which
// panel happened to make the request.
//
// Callers keep owning their ETag store (they key it differently — by project, by
// session, by ref), because that is the part that legitimately differs.

export type ConditionalResult<T> =
  | { kind: "fresh"; data: T; etag: string | null }
  | { kind: "not-modified" };

/**
 * GET with `If-None-Match`, returning a discriminated result instead of overloading
 * `null`. Errors are normalised through the same path as `apiFetch`, so a failing
 * conditional GET reports what a failing plain GET reports — and the body goes through
 * the same schema check, so the two entry points cannot disagree about what a valid
 * response is.
 *
 * Pass `etag` only when you have prior data to fall back on: a 304 with nothing cached
 * leaves the caller with nothing to render.
 */
export async function apiFetchConditional<T>(
  path: string,
  etag: string | null | undefined,
  init?: RequestInit,
  schema?: ResponseSchema<T>,
): Promise<ConditionalResult<T>> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (etag) headers["If-None-Match"] = etag;

  const res = await fetch(path, { ...init, headers });
  if (res.status === 304) return { kind: "not-modified" };
  if (!res.ok) await throwApiError(res);
  const body: unknown = await res.json();
  return {
    kind: "fresh",
    data: validateResponse<T>(methodOf(init), path, body, schema),
    etag: res.headers.get("ETag"),
  };
}

// ───────────────────────── Typed verb helpers ─────────────────────────
// Thin wrappers over apiFetch that own the `method` + `JSON.stringify(body)`
// boilerplate repeated across ~200 call sites. A bodyless call (e.g. a POST
// that takes no payload) omits the body entirely. Extra RequestInit (signal,
// headers) still threads through. Migrate call sites to these incrementally.
//
// The `method` they set is what the schema registry keys on, so a call made through
// these is validated and the same call hand-rolled with `apiFetch(path, { method })`
// is validated identically.

function withBody(method: string, body?: unknown, init?: RequestInit): RequestInit {
  return body === undefined
    ? { ...init, method }
    : { ...init, method, body: JSON.stringify(body) };
}

export function apiPost<T>(path: string, body?: unknown, init?: RequestInit, schema?: ResponseSchema<T>): Promise<T> {
  return apiFetch<T>(path, withBody("POST", body, init), schema);
}

export function apiPut<T>(path: string, body?: unknown, init?: RequestInit, schema?: ResponseSchema<T>): Promise<T> {
  return apiFetch<T>(path, withBody("PUT", body, init), schema);
}

export function apiPatch<T>(path: string, body?: unknown, init?: RequestInit, schema?: ResponseSchema<T>): Promise<T> {
  return apiFetch<T>(path, withBody("PATCH", body, init), schema);
}

export function apiDelete<T>(path: string, body?: unknown, init?: RequestInit, schema?: ResponseSchema<T>): Promise<T> {
  return apiFetch<T>(path, withBody("DELETE", body, init), schema);
}
