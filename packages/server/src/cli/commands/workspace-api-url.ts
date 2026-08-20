import { resolveBoardServerPort } from "@agentic-kanban/shared/lib/board-server-url";

export function buildWorkspaceApiUrl(
  port: string,
  workspaceId: string,
  action:
    | "launch"
    | "review"
    | "diff"
    | "scorecard"
    | "merge"
    | "close"
    | "stop"
    | "ready-for-merge"
    | "terminal"
    | "handoff-bundle"
    | "comments",
) {
  return buildApiUrl(port, `/api/workspaces/${encodeURIComponent(workspaceId)}/${action}`);
}

export function buildApiUrl(port: string, path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `http://127.0.0.1:${resolveBoardServerPort(port)}${normalizedPath}`;
}

export function resolveCliPort(override?: string): string {
  return String(resolveBoardServerPort(override));
}
