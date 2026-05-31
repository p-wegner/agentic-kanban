// Single source of truth for the deterministic dev-server ports the app assigns to a
// worktree. Mirrors scripts/dev.mjs: a feature/<N> (or ak-<N>) worktree gets
// server 3001+N / client 5173+N; any other worktree branch gets a stable hash offset.
//
// This is the app's OWN convention for its monorepo dev servers. It is used both to
// launch worktree agents (agent.service) and to free those ports on teardown
// (workspace-teardown.service). It is deliberately NOT the generic teardown mechanism —
// projects with other resource models (docker compose, remote sandboxes, etc.) use the
// configurable per-project teardownScript instead.

export const BASE_SERVER_PORT = 3001;
export const BASE_CLIENT_PORT = 5173;

export function branchHash(branchName: string): number {
  let hash = 0;
  for (let i = 0; i < branchName.length; i++) {
    hash = (hash * 31 + branchName.charCodeAt(i)) & 0xffff;
  }
  // Range 101-1000 to avoid colliding with issue numbers 1-100.
  return (hash % 900) + 101;
}

/**
 * The dev ports this app's convention would have assigned to the given worktree path,
 * or null when the path is not a worktree (so no app-managed ports to free).
 */
export function resolveWorktreeDevPorts(
  worktreePath: string,
): { serverPort: number; clientPort: number } | null {
  const normalized = worktreePath.replace(/\\/g, "/");
  if (!normalized.includes("/.worktrees/")) return null;

  const leaf = normalized.split("/").filter(Boolean).at(-1) ?? "";
  const issueMatch = leaf.match(/(?:^|[_/-])ak-(\d+)-/i) ?? leaf.match(/^feature[_/-](\d+)-/i);
  const offset = issueMatch ? Number(issueMatch[1]) : branchHash(leaf);
  return {
    serverPort: BASE_SERVER_PORT + offset,
    clientPort: BASE_CLIENT_PORT + offset,
  };
}
