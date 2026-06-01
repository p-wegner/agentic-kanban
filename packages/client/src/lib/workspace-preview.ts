const DEFAULT_CLIENT_PORT = 5173;
const DEFAULT_SERVER_PORT = 3001;

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
  const ports = getWorkspaceDevPorts(workspace);
  if (!ports.ok) return { ok: false, reason: ports.reason };
  return { ok: true, port: ports.clientPort, url: `http://127.0.0.1:${ports.clientPort}` };
}

export type WorkspaceDevPortsResult =
  | { ok: true; serverPort: number; clientPort: number; previewUrl: string }
  | { ok: false; reason: string };

export function getWorkspaceDevPorts(workspace: { branch?: string | null; isDirect?: boolean }): WorkspaceDevPortsResult {
  if (workspace.isDirect) {
    return {
      ok: true,
      serverPort: DEFAULT_SERVER_PORT,
      clientPort: DEFAULT_CLIENT_PORT,
      previewUrl: `http://127.0.0.1:${DEFAULT_CLIENT_PORT}`,
    };
  }

  const branch = workspace.branch?.trim();
  if (!branch) {
    return { ok: false, reason: "Dev ports unavailable: workspace branch is missing." };
  }

  const issueNumber = getIssueNumber(branch);
  const offset = issueNumber ?? branchHash(branch);
  const clientPort = DEFAULT_CLIENT_PORT + offset;
  const serverPort = DEFAULT_SERVER_PORT + offset;
  if (clientPort > 60000 || serverPort > 60000) {
    return { ok: false, reason: `Dev ports ${serverPort}/${clientPort} are outside the supported range.` };
  }

  return {
    ok: true,
    serverPort,
    clientPort,
    previewUrl: `http://127.0.0.1:${clientPort}`,
  };
}
