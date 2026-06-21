// Pure builder for the project butler REST URL. Appends ?butler=/&butler= for a
// non-default butler id; the default butler (empty/"default") uses the base path.

export function buildButlerUrl(projectId: string, butlerId: string, path: string): string {
  const base = `/api/projects/${projectId}/butler${path}`;
  if (!butlerId || butlerId === "default") return base;
  return `${base}${path.includes("?") ? "&" : "?"}butler=${encodeURIComponent(butlerId)}`;
}
