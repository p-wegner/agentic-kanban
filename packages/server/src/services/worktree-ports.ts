import { parseIssueNumberFromBranch } from "@agentic-kanban/shared/lib/branch";
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
 * The deterministic port offset encoded in a worktree branch (or path leaf): the issue
 * number for an `ak-<N>` / `feature/<N>` branch, otherwise a stable hash of the name.
 */
export function portOffsetFromName(name: string): number {
  // #548: the `ak-<N>` half is the shared parser. The legacy `feature/<N>-` form (no `ak-`)
  // stays LOCAL and deliberately out of the shared parser: it is the over-matching shape
  // that made `feature/2026-refresh` read as issue 2026, and an issue number must never be
  // guessed from a bare leading number. It is tolerable HERE and nowhere else, because this
  // value only picks a port — a wrong guess costs a port collision, not a wrong issue — and
  // because changing it would move the ports of worktrees that already exist.
  const issueNumber = parseIssueNumberFromBranch(name);
  if (issueNumber !== null) return issueNumber;
  const legacyMatch = name.match(/^feature[_/-](\d+)-/i);
  return legacyMatch ? Number(legacyMatch[1]) : branchHash(name);
}

/** The server/client dev ports for a given offset. */
export function portsForOffset(offset: number): { serverPort: number; clientPort: number } {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    clientPort: BASE_CLIENT_PORT + offset,
  };
}

/** The dev ports this app's convention assigns to a worktree on the given branch. */
export function derivePortsFromBranch(branch: string): { serverPort: number; clientPort: number } {
  return portsForOffset(portOffsetFromName(branch));
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
  return portsForOffset(portOffsetFromName(leaf));
}
