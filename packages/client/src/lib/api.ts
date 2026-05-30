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
      if ((body as any).error) message = (body as any).error;
    } catch {
      // response body wasn't JSON, use default message
    }
    throw Object.assign(new Error(message), { body });
  }
  return res.json();
}
