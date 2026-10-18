/**
 * The board's watch on GitHub CI for the base branch (#1562). Polls `gh run list` (read-only,
 * the operator's existing `gh` auth), keeps the latest verdict per project for the console /
 * delivery view, and files one heal ticket per sustained-red workflow.
 *
 * Skips cleanly everywhere: no repo path, no `gh`, not a GitHub repo, unauthenticated, a malformed
 * answer — each leaves the previous snapshot alone and never throws into the sweep.
 *
 * Heal tickets are keyed `ci-heal:<projectId>:<workflow>` (NOT the base-health heal prefix, so a
 * green nightly sweep cannot close a CI ticket): at most one open ticket per workflow, refreshed
 * while red, closed with a comment when the workflow is green again.
 */
import { LEGACY_TERMINAL_STATUS_NAMES } from "@agentic-kanban/shared/lib/status-view";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import type { ExecResult } from "@agentic-kanban/shared/lib/exec-result";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { HEAL_TICKET_TAG } from "../lib/heal-ticket-key.js";
import {
  GH_RUN_LIST_FIELDS,
  ciHealBody,
  ciHealExternalKey,
  ciHealKeyScanPrefix,
  ciHealTitle,
  parseFailedJobs,
  parseGhRunList,
  parseRequiredWorkflows,
  summarizeWorkflows,
  sustainedRed,
  toCiSnapshot,
  type CiSnapshot,
  type FailedJob,
  type WorkflowCiState,
} from "../lib/ci-status.js";
import { ghExec } from "../lib/gh-exec.js";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { getDoneStatusIds, updateIssueById } from "../repositories/issue-service.repository.js";
import { getMinIssueSortOrder, listIssuesByExternalKeyPrefix } from "../repositories/issue/heal-ticket.repository.js";
import { createIssueService, type CreateIssueInput, type CreateIssueResult } from "./issue.service.js";
import { applyIssueTag } from "./repo-tags.service.js";

const HEAL_TAG_COLOR = "#dc2626";
/** Runs fetched per poll: enough history for a streak across every push workflow. */
const RUN_LIST_LIMIT = 60;

const requiredWorkflowsPref = projectPref("ci_required_workflows");
export function ciRequiredWorkflowsPrefKey(projectId: string): string {
  return requiredWorkflowsPref.key(projectId);
}

export type GhRunner = (args: string[], opts: { cwd?: string }) => Promise<ExecResult>;

const snapshots = new Map<string, CiSnapshot>();

/** The latest snapshot for a project, or null when none was ever taken (gh unavailable, never polled). */
export function getCiSnapshot(projectId: string): CiSnapshot | null {
  return snapshots.get(projectId) ?? null;
}

export function clearCiSnapshotsForTest(): void {
  snapshots.clear();
}

export interface CiPollResult {
  status: "skipped" | "polled";
  reason?: string;
  states: WorkflowCiState[];
  tickets: Array<{ workflow: string; action: "created" | "updated" | "closed"; issueNumber?: number }>;
}

export interface CiPollDeps {
  gh?: GhRunner;
  createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
  /** ISO now (persisted in ticket timestamps). */
  now?: string;
}

/** Poll one project's base branch CI, update its snapshot, reconcile heal tickets. Never throws. */
export async function pollProjectCi(projectId: string, database: Database = db, deps: CiPollDeps = {}): Promise<CiPollResult> {
  const skipped = (reason: string): CiPollResult => ({ status: "skipped", reason, states: [], tickets: [] });
  try {
    const gh = deps.gh ?? ghExec;
    const project = await getProjectById(projectId, database);
    if (!project?.repoPath || !project.defaultBranch) return skipped("project has no repo path or default branch");
    const branch = project.defaultBranch;

    const list = await gh(["run", "list", "--branch", branch, "--event", "push", "--limit", String(RUN_LIST_LIMIT), "--json", GH_RUN_LIST_FIELDS], { cwd: project.repoPath });
    if (!execSucceeded(list)) return skipped(`gh run list unavailable: ${(list.stderr || list.error?.message || "no exit code").trim().split("\n")[0]}`);
    const runs = parseGhRunList(list.stdout);
    if (!runs) return skipped("gh run list returned something other than a JSON array");

    const required = parseRequiredWorkflows(await getPreference(ciRequiredWorkflowsPrefKey(projectId), database).catch(() => null));
    const states = summarizeWorkflows(runs, required);
    const now = deps.now ?? new Date().toISOString();
    const ahead = await commitsAheadOfRedRuns(states, branch, project.repoPath);
    snapshots.set(projectId, toCiSnapshot(branch, states, now, ahead));
    const tickets = await reconcileCiHealTickets({ projectId, branch, states, repoPath: project.repoPath, gh, createIssue: deps.createIssue, now }, database);
    return { status: "polled", states, tickets };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[ci-status] poll failed for project ${projectId} (non-fatal): ${reason}`);
    return skipped(`poll failed: ${reason}`);
  }
}

/** Per sustained-red workflow: base-branch commits beyond the red run's head sha (unpushed local work, #1597). Best effort. */
async function commitsAheadOfRedRuns(states: readonly WorkflowCiState[], branch: string, repoPath: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const s of sustainedRed(states)) {
    const sha = s.latest.headSha;
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
    const res = await gitExec(["rev-list", "--count", `${sha}..${branch}`], { cwd: repoPath }).catch(() => null);
    const n = res && execSucceeded(res) ? Number.parseInt(res.stdout.trim(), 10) : NaN;
    if (Number.isFinite(n) && n > 0) out.set(s.workflow, n);
  }
  return out;
}

/** Heal-ticket keys already logged as "same run already healed", so a poll loop logs once. */
const loggedAlreadyHealed = new Set<string>();

/** True when a CLOSED heal ticket for this key was filed against the same run (id/url) or head sha. */
function healedBefore(closed: readonly { description: string | null }[], state: WorkflowCiState): boolean {
  const { url, headSha } = state.latest;
  return closed.some((r) => {
    const d = r.description ?? "";
    return (url !== "" && d.includes(url)) || (headSha !== "" && d.includes(`\`${headSha}\``));
  });
}

async function failedJobsOf(state: WorkflowCiState, repoPath: string, gh: GhRunner): Promise<FailedJob[]> {
  const id = state.latest.databaseId;
  if (id === undefined) return [];
  const view = await gh(["run", "view", String(id), "--json", "jobs"], { cwd: repoPath });
  return execSucceeded(view) ? parseFailedJobs(view.stdout) : [];
}

/** One open ticket per sustained-red workflow; a workflow that is green closes its ticket. */
export async function reconcileCiHealTickets(
  input: { projectId: string; branch: string; states: readonly WorkflowCiState[]; repoPath: string; gh: GhRunner; createIssue?: CiPollDeps["createIssue"]; now: string },
  database: Database = db,
): Promise<CiPollResult["tickets"]> {
  const { projectId, branch, states, now } = input;
  const rows = await listIssuesByExternalKeyPrefix(projectId, ciHealKeyScanPrefix(projectId), database);
  const open = rows.filter((r) => r.externalKey && !LEGACY_TERMINAL_STATUS_NAMES.has(r.statusName ?? ""));
  const out: CiPollResult["tickets"] = [];

  for (const state of states) {
    const key = ciHealExternalKey(projectId, state.workflow);
    const existing = open.find((r) => r.externalKey === key);
    if (state.verdict === "red" && state.sustained) {
      if (!existing && healedBefore(rows.filter((r) => r.externalKey === key), state)) {
        const logKey = `${key}@${state.latest.headSha || state.latest.url}`;
        if (!loggedAlreadyHealed.has(logKey)) {
          loggedAlreadyHealed.add(logKey);
          console.log(`[ci-status] project ${projectId}: workflow '${state.workflow}' still red on run ${state.latest.url} (${state.latest.headSha}), but a closed heal ticket already covers that run — not filing again; the fix may be local and unpushed`);
        }
        continue;
      }
      const body = ciHealBody(branch, state, await failedJobsOf(state, input.repoPath, input.gh));
      const title = ciHealTitle(branch, state.workflow);
      console.log(`[ci-status] project ${projectId}: workflow '${state.workflow}' red on '${branch}' since ${state.redSince} — ${existing ? `refreshing heal ticket #${existing.issueNumber}` : "filing heal ticket"}`);
      if (existing) {
        await updateIssueById(existing.id, { title, description: body, priority: "critical", updatedAt: now }, database);
        out.push({ workflow: state.workflow, action: "updated", issueNumber: existing.issueNumber ?? undefined });
        continue;
      }
      const createIssue = input.createIssue ?? createIssueService({ database }).createIssue;
      const minSort = await getMinIssueSortOrder(projectId, database);
      const issue = await createIssue({ projectId, title, description: body, issueType: "task", priority: "critical", sortOrder: (minSort ?? 0) - 1, externalKey: key });
      await applyIssueTag(issue.id, HEAL_TICKET_TAG, HEAL_TAG_COLOR, database).catch(() => {});
      out.push({ workflow: state.workflow, action: "created", issueNumber: issue.issueNumber ?? undefined });
    } else if (state.verdict === "green" && existing) {
      const note = `CI workflow '${state.workflow}' is green again on '${branch}' (run ${state.latest.url}) — the red this ticket was filed for is gone.`;
      await insertIssueComment({ issueId: existing.id, kind: "note", author: "system", body: note, createdAt: now }, database).catch(() => {});
      const done = await getDoneStatusIds(projectId, database);
      if (done.length > 0) {
        await updateIssueById(existing.id, { statusId: done[0], statusChangedAt: now, updatedAt: now }, database);
        out.push({ workflow: state.workflow, action: "closed", issueNumber: existing.issueNumber ?? undefined });
      }
    }
  }
  return out;
}
