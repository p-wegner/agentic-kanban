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
  return `http://127.0.0.1:${port}/api/workspaces/${encodeURIComponent(workspaceId)}/${action}`;
}

export function buildApiUrl(port: string, path: string) {
  return `http://127.0.0.1:${port}${path}`;
}
