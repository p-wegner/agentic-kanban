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
    throw Object.assign(new Error(message), { body });
  }
  return res.json();
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
