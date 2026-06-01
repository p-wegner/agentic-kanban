const DEFAULT_SERVER_PORT = 3001;
const DEFAULT_CLIENT_PORT = 5173;

export function getIssueNumber(branchName) {
  const match = branchName.match(/^feature\/(?:ak-)?(\d+)-/);
  return match ? parseInt(match[1], 10) : null;
}

export function branchHash(branchName) {
  let hash = 0;
  for (let i = 0; i < branchName.length; i++) {
    hash = (hash * 31 + branchName.charCodeAt(i)) & 0xffff;
  }
  // Use range 101-1000 to avoid collisions with issue numbers 1-100
  return (hash % 900) + 101;
}

export function resolveDevPorts({ isWorktree, branch }) {
  if (isWorktree && branch) {
    const issueNum = getIssueNumber(branch);
    const offset = issueNum !== null ? issueNum : branchHash(branch);
    const serverPort = DEFAULT_SERVER_PORT + offset;
    const clientPort = DEFAULT_CLIENT_PORT + offset;
    return { serverPort, clientPort, offset };
  }

  return { serverPort: DEFAULT_SERVER_PORT, clientPort: DEFAULT_CLIENT_PORT, offset: 0 };
}
