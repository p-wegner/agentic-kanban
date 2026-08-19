import { getPreference } from "../repositories/preferences.repository.js";
import { parseIssueRef } from "@agentic-kanban/shared/lib/issue-ref";
import type { issues } from "@agentic-kanban/shared/schema";

// Migration bootstrap lives in the db layer so cli/ never imports db/index directly.
export { runMigrations } from "../db/manual-migrate.js";
import { runMigrations as runMigrationsForAction } from "../db/manual-migrate.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";


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

/**
 * Resolve a CLI issue-number argument to `{ projectId, issueNumber, issueId }` (#509).
 *
 * Twelve handlers repeated the same prelude — resolve the project, `Number()` the argument,
 * check it is a positive integer, look the issue up, and on a miss print the #467
 * cross-project explanation. Two of them had DRIFTED: `workspace wait` and
 * `session find-similar` used the active project only (no `--project`) and printed a bare
 * "Issue #N not found.", which is the exact wrong conclusion #467 exists to prevent —
 * numbers are per-project, so the ticket usually does exist, elsewhere.
 *
 * It RETURNS a result rather than exiting, because the callers do not agree on how to fail:
 * most `process.exit(1)`, but `runWorkspaceWait` returns its exit code to a caller that
 * still has cleanup to do. A helper that exited would have silently changed that contract.
 */
export type IssueNumberResolution =
  | { ok: true; projectId: string; issueNumber: number; issueId: string }
  | { ok: false; message: string };

export async function resolveIssueNumberArg(
  issueNumberArg: string,
  options: { project?: string } = {},
): Promise<IssueNumberResolution> {
  const issueNumber = Number(issueNumberArg);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { ok: false, message: `Invalid issue number: ${issueNumberArg}` };
  }

  const projectId = await resolveProjectIdArg(options.project);
  const { getIssueIdByNumberInProject } = await import("../repositories/issue.repository.js");
  const issueId = await getIssueIdByNumberInProject(issueNumber, projectId);
  if (issueId === null) {
    return { ok: false, message: await describeIssueNumberMiss(issueNumber, projectId) };
  }
  return { ok: true, projectId, issueNumber, issueId };
}

/**
 * Resolve a CLI issue ARGUMENT that may be a number or a full id (#509).
 *
 * The sibling above (`resolveIssueNumberArg`) handles commands whose argument is a number
 * by contract. `issue update` and `issue move` accept either spelling, and both had their
 * own copy of the branch — `isNumeric ? resolveProjectIdArg(...) : undefined`, look up, then
 * print a bare `Issue '42' not found.`. For a NUMERIC ref that message is the exact wrong
 * conclusion #467 exists to prevent: numbers are per-project, so the ticket usually does
 * exist, in another project. Routing both through here means the explanation reaches them
 * too, and the number-or-id decision is `parseIssueRef`'s alone.
 *
 * Returns rather than exits, for the same reason `resolveIssueNumberArg` does — the callers
 * do not agree on how to fail.
 */
export async function resolveIssueArg(
  issueArg: string,
  options: { project?: string } = {},
): Promise<{ ok: true; issue: typeof issues.$inferSelect } | { ok: false; message: string }> {
  const ref = parseIssueRef(issueArg);
  const projectId = ref.kind === "number" ? await resolveProjectIdArg(options.project) : undefined;
  const { getIssueByNumberOrId } = await import("../repositories/issue/cli-commands.repository.js");
  const issue = await getIssueByNumberOrId(issueArg, projectId);
  if (issue) return { ok: true, issue };
  if (ref.kind === "number" && projectId) {
    return { ok: false, message: await describeIssueNumberMiss(ref.issueNumber, projectId) };
  }
  return { ok: false, message: `Issue '${issueArg}' not found.` };
}

/**
 * The CLI action prelude/epilogue, once (#505).
 *
 * 102 commander handlers opened with `try { await runMigrations();` and 87 of them closed
 * with the byte-identical `catch (err) { console.error("Error:", errorMessage(err));
 * process.exit(1); }`. That is ~380 lines of ceremony, and the copies had already started to
 * drift: `workspace wait` ran WITHOUT `runMigrations()`, which is the whole "forgot the
 * migration" failure class.
 *
 * Deliberately NOT `process.exit(code ?? 0)` on the success path. Most handlers already exit
 * explicitly where they mean to, and forcing an exit here would change every other handler
 * from "return and let node drain stdout" to "kill the process mid-write" — on Windows that
 * truncates piped output. A handler that wants a non-zero code returns it; everything else
 * ends the way it always did.
 */
export function cliAction<A extends unknown[]>(
  fn: (...args: A) => Promise<number | void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await runMigrationsForAction();
      const code = await fn(...args);
      if (code) process.exit(code);
    } catch (err) {
      console.error("Error:", errorMessage(err));
      process.exit(1);
    }
  };
}
