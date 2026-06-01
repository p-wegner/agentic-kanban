export function buildWorkspaceApiUrl(port: string, workspaceId: string, action: "launch" | "review") {
  return `http://127.0.0.1:${port}/api/workspaces/${encodeURIComponent(workspaceId)}/${action}`;
}
