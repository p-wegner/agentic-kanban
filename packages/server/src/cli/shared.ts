import { getPreference } from "../repositories/preferences.repository.js";

// Migration bootstrap lives in the db layer so cli/ never imports db/index directly.
export { runMigrations } from "../db/manual-migrate.js";

export const DEFAULT_STATUSES = [
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "AI Reviewed", sortOrder: 3, isDefault: false },
  { name: "Done", sortOrder: 4, isDefault: false },
  { name: "Cancelled", sortOrder: 5, isDefault: false },
];

export function logDefaultBranch(defaultBranch: string | null | undefined, indent = "  ") {
  if (defaultBranch) {
    console.log(`${indent}Branch: ${defaultBranch}`);
    return;
  }
  console.warn(`${indent}Warning: no default branch detected (looked for local main, then master).`);
  console.warn(`${indent}Set it manually in project settings before creating worktrees.`);
}

export async function getActiveProjectId(): Promise<string> {
  const value = await getPreference("activeProjectId");
  if (value === null) throw new Error("No active project. Run `pnpm cli -- register <path>` first.");
  return value;
}

/**
 * Explain an issue-number miss instead of just denying it (#467).
 *
 * Issue numbers are per-project. A command run against the active project would report a bare
 * "Issue #462 not found in active project" for a number that exists — in a DIFFERENT project.
 * That reads as "the ticket does not exist", which is the wrong conclusion and sends the reader
 * (often an agent, since CLAUDE.md tells them `#N` is always a kanban number) off investigating
 * a phantom. Real instance: `workspace resume 462` denied a ticket that was open the whole time.
 *
 * Returns a message naming the owning project(s) and the flag to use, or the plain not-found
 * line when the number genuinely exists nowhere.
 */
export async function describeIssueNumberMiss(issueNumber: number, activeProjectId: string): Promise<string> {
  const { findProjectsWithIssueNumber } = await import("../repositories/issue/cli-commands.repository.js");
  let owners: Awaited<ReturnType<typeof findProjectsWithIssueNumber>>;
  try {
    owners = await findProjectsWithIssueNumber(issueNumber);
  } catch {
    // Never let the nicety break the error path it is decorating.
    return `Issue #${issueNumber} not found in the active project.`;
  }
  const elsewhere = owners.filter((o) => o.projectId !== activeProjectId);
  if (elsewhere.length === 0) return `Issue #${issueNumber} not found in any project.`;
  const list = elsewhere.map((o) => `'${o.projectName}'`).join(", ");
  return (
    `Issue #${issueNumber} does not exist in the active project — it belongs to ${list}.\n` +
    `  Re-run with --project ${JSON.stringify(elsewhere[0].projectName)} (or pass the project id).`
  );
}

/**
 * Resolve the project a command should act on: `--project <name|id>` when given, else the active
 * project. Name match is exact first, then case-insensitive, so `--project pantry` works.
 */
export async function resolveProjectIdArg(projectArg?: string): Promise<string> {
  if (!projectArg) return getActiveProjectId();
  const { getAllProjects } = await import("../repositories/project.repository.js");
  // Archived projects included: naming one explicitly is a deliberate act, and refusing to find
  // it would be a second confusing "no such project" for a project the user can see in the UI.
  const all = await getAllProjects(undefined, { includeArchived: true });
  const byId = all.find((p) => p.id === projectArg);
  if (byId) return byId.id;
  const exact = all.find((p) => p.name === projectArg);
  if (exact) return exact.id;
  const loose = all.filter((p) => p.name.toLowerCase() === projectArg.toLowerCase());
  if (loose.length === 1) return loose[0].id;
  if (loose.length > 1) {
    throw new Error(`Several projects are named "${projectArg}" — pass the project id instead.`);
  }
  throw new Error(`No project named "${projectArg}". Run \`pnpm cli -- list\` to see them.`);
}

export function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
