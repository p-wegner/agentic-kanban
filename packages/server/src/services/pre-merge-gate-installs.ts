import type { Database } from "../db/index.js";
import { listWorkspaceRepoInstallStates } from "../repositories/repo.repository.js";
import { blocksMerge } from "@agentic-kanban/shared/lib/repo-install-state";

/**
 * #628 — the one-line reason a merge must wait on (or refuse) deferred dependency installs,
 * or null when nothing is outstanding.
 *
 * Deliberately never throws: a read failure here means we cannot tell, and refusing every
 * merge in the project on an unreadable repo row would be a far worse failure than the one
 * this guards against. It degrades to today's behaviour instead.
 */
export async function describeOutstandingRepoInstalls(
  workspaceId: string,
  database: Database,
): Promise<string | null> {
  const rows = await listWorkspaceRepoInstallStates(workspaceId, database).catch(() => []);
  const blocking = rows.filter((r) => blocksMerge(r.installState));
  if (blocking.length === 0) return null;
  const failed = blocking.filter((r) => r.installState === "failed");
  const naming = (r: { name: string | null; path: string }) => r.name ?? r.path;
  if (failed.length > 0) {
    const first = failed[0];
    return `pre-merge gate blocked: dependency install FAILED for ${failed.length} repo(s) — ${failed.map(naming).join(", ")}. First failure: ${first.installDetail ?? "no detail recorded"}. This branch was built without its dependencies; fix the install and relaunch before merging.`;
  }
  return `pre-merge gate blocked: dependency installs still running for ${blocking.length} repo(s) — ${blocking.map(naming).join(", ")}. Deferred installs (install mode: background) must finish before a merge can be verified.`;
}
