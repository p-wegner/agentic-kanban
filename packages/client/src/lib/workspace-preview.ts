const DEFAULT_CLIENT_PORT = 5173;

export type WorkspacePreviewResult =
  | { ok: true; port: number; url: string }
  | { ok: false; reason: string };

function getIssueNumber(branchName: string): number | null {
  const match = branchName.match(/^feature\/(?:ak-)?(\d+)-/);
  return match ? parseInt(match[1], 10) : null;
}

function branchHash(branchName: string): number {
  let hash = 0;
  for (let i = 0; i < branchName.length; i++) {
    hash = (hash * 31 + branchName.charCodeAt(i)) & 0xffff;
  }
  return (hash % 900) + 101;
}

export function getWorkspacePreviewUrl(workspace: { branch?: string | null; isDirect?: boolean }): WorkspacePreviewResult {
  if (workspace.isDirect) {
    const url = `http://127.0.0.1:${DEFAULT_CLIENT_PORT}`;
    return { ok: true, port: DEFAULT_CLIENT_PORT, url };
  }

  const branch = workspace.branch?.trim();
  if (!branch) {
    return { ok: false, reason: "Preview port unavailable: workspace branch is missing." };
  }

  const issueNumber = getIssueNumber(branch);
  const offset = issueNumber ?? branchHash(branch);
  const port = DEFAULT_CLIENT_PORT + offset;
  if (port > 60000) {
    return { ok: false, reason: `Preview port ${port} is outside the supported dev range.` };
  }

  return { ok: true, port, url: `http://127.0.0.1:${port}` };
}
