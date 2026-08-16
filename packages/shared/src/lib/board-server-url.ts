const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 3001;

export function resolveBoardServerPort(override?: string | number): number {
  if (override !== undefined) {
    const parsed = Number(override);
    if (parsed) return parsed;
  }
  return (
    Number(process.env.KANBAN_BOARD_SERVER_PORT) ||
    Number(process.env.KANBAN_SERVER_PORT) ||
    Number(process.env.SERVER_PORT) ||
    Number(process.env.PORT) ||
    DEFAULT_PORT
  );
}

export function boardApiUrl(path: string, port?: string | number): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `http://${LOOPBACK_HOST}:${resolveBoardServerPort(port)}${normalizedPath}`;
}

export async function boardApi(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(boardApiUrl(path), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body */
  }
  return { ok: res.ok, status: res.status, data };
}
