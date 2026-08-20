export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
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
  return res.json() as Promise<T>;
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
 * conditional GET reports what a failing plain GET reports.
 *
 * Pass `etag` only when you have prior data to fall back on: a 304 with nothing cached
 * leaves the caller with nothing to render.
 */
export async function apiFetchConditional<T>(
  path: string,
  etag: string | null | undefined,
  init?: RequestInit,
): Promise<ConditionalResult<T>> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (etag) headers["If-None-Match"] = etag;

  const res = await fetch(path, { ...init, headers });
  if (res.status === 304) return { kind: "not-modified" };
  if (!res.ok) {
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
  return { kind: "fresh", data: (await res.json()) as T, etag: res.headers.get("ETag") };
}

// ───────────────────────── Typed verb helpers ─────────────────────────
// Thin wrappers over apiFetch that own the `method` + `JSON.stringify(body)`
// boilerplate repeated across ~200 call sites. A bodyless call (e.g. a POST
// that takes no payload) omits the body entirely. Extra RequestInit (signal,
// headers) still threads through. Migrate call sites to these incrementally.

function withBody(method: string, body?: unknown, init?: RequestInit): RequestInit {
  return body === undefined
    ? { ...init, method }
    : { ...init, method, body: JSON.stringify(body) };
}

export function apiPost<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  return apiFetch<T>(path, withBody("POST", body, init));
}

export function apiPut<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  return apiFetch<T>(path, withBody("PUT", body, init));
}

export function apiPatch<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  return apiFetch<T>(path, withBody("PATCH", body, init));
}

export function apiDelete<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  return apiFetch<T>(path, withBody("DELETE", body, init));
}
