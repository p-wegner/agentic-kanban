// Visibility and reclaim for the fleet's incoming-ref staging namespace (#752).
//
// Decision 012 promises that a worker push which cannot be fast-forwarded is
// "reported and held". Only the second half was true: the startup sweep
// `console.warn`ed each refusal, dropped its `held` list on the floor, and no
// route, tool or panel could enumerate `refs/kanban/incoming/*`. A worker's only
// copy of an hour's work could sit in that namespace indefinitely, re-announced
// as one boot log line nobody reads, and stale entries also trip git's
// directory/file conflict when a later branch is named `<branch>/x`.
//
// THE INVENTORY IS GIT, NOT A TABLE. Every fact below is read live from the
// refs, so the listing can never drift from what the repo actually holds — a
// mirror table would need its own reconciler to stay honest about refs that
// were landed, deleted or pushed while the board was down.
//
// RETENTION RULE, stated plainly because deleting a ref can destroy the only
// copy of an agent's work:
//   * The automatic pass (`reclaimLandedIncomingRefs`, run by the startup sweep)
//     deletes ONLY refs whose commit is already reachable from the real branch or
//     from the project's default branch. Such a ref is provably redundant — the
//     work is on a branch — so no age threshold is needed and nothing can be lost.
//     This subsumes the ticket's "drop refs whose workspace is Done/deleted": a
//     Done workspace merged its branch, so its commit IS reachable. Proving it
//     beats assuming it from a status column.
//   * A ref holding UNREACHABLE commits is never deleted automatically at any
//     age. It is reported as held, and marked `stale` once older than
//     INCOMING_REF_STALE_AFTER_MS so an operator can see what is safe to clear.
//     Dropping it takes an explicit, logged `discardIncomingRef` call.

import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { KANBAN_INCOMING_REF_PREFIX } from "./git-http.service.js";
import {
  incomingRefFor,
  syncIncomingBranch,
  clearIncomingRef,
  type SyncOutcome,
} from "./worker-remote-sync.service.js";
import { getAllProjects } from "../repositories/project.repository.js";
import { listWorkerAssignedBranches, listWorkerBranchAssignments } from "../repositories/worker.repository.js";
import { recordWorkerEvent } from "./worker-events.service.js";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { emptyPassReport, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";

/**
 * How old a held incoming ref must be before it is flagged as reclaimable.
 *
 * Two weeks: long enough that a genuinely useful result has been noticed and
 * landed, short enough that the namespace does not accumulate for a year. The
 * flag NEVER by itself deletes anything (see the retention rule above) — it only
 * tells an operator which held refs are old enough to be worth a decision.
 */
export const INCOMING_REF_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** One incoming ref, with everything needed to decide what to do with it. */
export interface IncomingRefView {
  projectId: string;
  projectName: string;
  branch: string;
  ref: string;
  sha: string;
  subject: string;
  /** Committer date of the pushed tip — the closest thing to "when the worker pushed". */
  committedAt: string;
  ageMs: number;
  /** False when the branch name would produce an unusable ref (D/F conflicts, control chars). */
  validRefName: boolean;
  /** Does the DB hold a worker dispatch for this project + branch? (#246 — landing requires one.) */
  hasWorkerAssignment: boolean;
  branchExists: boolean;
  /** The commit is already reachable from the real branch or the default branch. */
  alreadyLanded: boolean;
  /** null when the ref could be landed right now; otherwise why it is held. */
  heldReason: string | null;
  /** Old enough that an operator may reasonably discard it. Never triggers a delete by itself. */
  stale: boolean;
}

export interface IncomingRefsReport {
  refs: IncomingRefView[];
  /** The retention threshold in force, so a caller never has to guess it. */
  staleAfterMs: number;
}

interface ProjectRepo {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string | null;
}

async function loadProjectRepos(database: Database, projectId?: string): Promise<ProjectRepo[]> {
  const rows = await getAllProjects(database, { includeArchived: true });
  return rows
    .filter((p) => Boolean(p.repoPath) && (!projectId || p.id === projectId))
    .map((p) => ({
      id: p.id,
      name: p.name,
      repoPath: p.repoPath as string,
      defaultBranch: p.defaultBranch ?? null,
    }));
}

interface RawRef {
  branch: string;
  sha: string;
  committedAt: string;
  subject: string;
}

/** ASCII unit separator: cannot occur in a ref name, a sha, or a git date. */
const FIELD_SEP = "\u001f";

/** Every incoming ref in one repo, with the metadata a listing needs, in ONE git call. */
export async function listRawIncomingRefs(repoPath: string): Promise<RawRef[]> {
  const format = ["%(refname)", "%(objectname)", "%(committerdate:iso-strict)", "%(contents:subject)"].join(FIELD_SEP);
  const result = await gitExec(["for-each-ref", `--format=${format}`, KANBAN_INCOMING_REF_PREFIX], { cwd: repoPath });
  if (!execSucceeded(result)) return [];
  const out: RawRef[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [refname = "", sha = "", committedAt = "", subject = ""] = line.split(FIELD_SEP);
    if (!refname.startsWith(KANBAN_INCOMING_REF_PREFIX)) continue;
    const branch = refname.slice(KANBAN_INCOMING_REF_PREFIX.length);
    if (!branch) continue;
    out.push({ branch, sha: sha.trim(), committedAt: committedAt.trim(), subject: subject.trim() });
  }
  return out;
}

/** Is `<name>` usable as a branch ref at all? Pure validation — resolves nothing. */
async function isValidBranchRefName(repoPath: string, branch: string): Promise<boolean> {
  if (!branch || branch.includes("..") || branch.endsWith("/") || branch.startsWith("/")) return false;
  const check = await gitExec(["check-ref-format", `refs/heads/${branch}`], { cwd: repoPath });
  return execSucceeded(check);
}

async function isAncestor(repoPath: string, sha: string, of: string): Promise<boolean> {
  const exists = await gitExec(["rev-parse", "--verify", `${of}^{commit}`], { cwd: repoPath });
  if (!execSucceeded(exists)) return false;
  return execSucceeded(await gitExec(["merge-base", "--is-ancestor", sha, of], { cwd: repoPath }));
}

async function describeRef(
  project: ProjectRepo,
  raw: RawRef,
  assigned: Set<string>,
  nowMs: number,
): Promise<IncomingRefView> {
  const target = `refs/heads/${raw.branch}`;
  const validRefName = await isValidBranchRefName(project.repoPath, raw.branch);
  const branchExists = execSucceeded(
    await gitExec(["rev-parse", "--verify", `${target}^{commit}`], { cwd: project.repoPath }),
  );
  const onBranch = branchExists && (await isAncestor(project.repoPath, raw.sha, target));
  const onDefault = project.defaultBranch
    ? await isAncestor(project.repoPath, raw.sha, `refs/heads/${project.defaultBranch}`)
    : false;
  const alreadyLanded = onBranch || onDefault;
  const hasWorkerAssignment = assigned.has(raw.branch);
  const committedMs = Date.parse(raw.committedAt);
  const ageMs = Number.isFinite(committedMs) ? Math.max(0, nowMs - committedMs) : 0;

  let heldReason: string | null = null;
  if (!validRefName) {
    heldReason = "branch name is not a valid git ref";
  } else if (alreadyLanded) {
    heldReason = onBranch
      ? `already landed on ${raw.branch}`
      : `already landed on ${project.defaultBranch}`;
  } else if (!hasWorkerAssignment) {
    // #246 — the ref alone proves nothing about who pushed it.
    heldReason = "no worker assignment for this branch";
  } else if (branchExists && !(await isAncestor(project.repoPath, `${target}^{commit}`, raw.sha))) {
    heldReason = `diverged from ${raw.branch} on the board`;
  }

  return {
    projectId: project.id,
    projectName: project.name,
    branch: raw.branch,
    ref: incomingRefFor(raw.branch),
    sha: raw.sha,
    subject: raw.subject,
    committedAt: raw.committedAt,
    ageMs,
    validRefName,
    hasWorkerAssignment,
    branchExists,
    alreadyLanded,
    heldReason,
    stale: ageMs > INCOMING_REF_STALE_AFTER_MS,
  };
}

/**
 * Every incoming ref the board is holding, across projects — the answer to
 * "where did my worker's result go?". Read-only; touches no ref.
 */
export async function listIncomingRefs(
  database: Database = realDb,
  opts: { projectId?: string; nowMs?: number } = {},
): Promise<IncomingRefsReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const refs: IncomingRefView[] = [];
  for (const project of await loadProjectRepos(database, opts.projectId)) {
    const raws = await listRawIncomingRefs(project.repoPath);
    if (raws.length === 0) continue;
    let assigned: Set<string>;
    try {
      assigned = await listWorkerAssignedBranches(project.id, database);
    } catch {
      assigned = new Set();
    }
    for (const raw of raws) refs.push(await describeRef(project, raw, assigned, nowMs));
  }
  refs.sort((a, b) => b.ageMs - a.ageMs);
  return { refs, staleAfterMs: INCOMING_REF_STALE_AFTER_MS };
}

export type LandIncomingRefResult =
  | { ok: true; outcome: SyncOutcome }
  | { ok: false; error: string; outcome?: SyncOutcome };

/**
 * Operator-triggered landing of ONE held ref — the "land" action the panel and any
 * CLI verb should call. Keeps #246's assignment gate: an unmatched ref is refused
 * here exactly as the sweep refuses it, so this is not a way around it.
 */
export async function landIncomingRef(
  projectId: string,
  branch: string,
  database: Database = realDb,
): Promise<LandIncomingRefResult> {
  const [project] = await loadProjectRepos(database, projectId);
  if (!project) return { ok: false, error: `project ${projectId} has no repo path` };
  const assigned = await listWorkerAssignedBranches(project.id, database);
  if (!assigned.has(branch)) {
    return { ok: false, error: `no worker assignment for ${branch}; refusing to land it (#246)` };
  }
  const outcome = await syncIncomingBranch(project.repoPath, branch);
  if (!outcome.ok) {
    console.warn(`[worker-incoming] land ${branch} refused: ${outcome.error}`);
    return { ok: false, error: outcome.error, outcome };
  }
  await clearIncomingRef(project.repoPath, branch).catch(() => {});
  console.log(`[worker-incoming] landed ${branch} via ${outcome.via} (${outcome.status}) on operator request`);
  return { ok: true, outcome };
}

/**
 * Operator-triggered discard of ONE held ref. This is the only path that can
 * delete a ref holding unreachable commits, and it says so in the log — the sha
 * is printed so the objects remain findable until git gcs them.
 *
 * Refuses a ref that is neither already landed nor past the staleness threshold
 * unless `force` is passed, so a fat-fingered click cannot drop this morning's work.
 */
export async function discardIncomingRef(
  projectId: string,
  branch: string,
  database: Database = realDb,
  opts: { force?: boolean; nowMs?: number } = {},
): Promise<{ ok: boolean; error?: string; sha?: string }> {
  const { refs } = await listIncomingRefs(database, { projectId, nowMs: opts.nowMs });
  const view = refs.find((r) => r.branch === branch);
  if (!view) return { ok: false, error: `no incoming ref for ${branch} in project ${projectId}` };
  if (!view.alreadyLanded && !view.stale && !opts.force) {
    return {
      ok: false,
      error:
        `${branch} holds commits that are on no branch and is only ${Math.round(view.ageMs / 3600000)}h old; ` +
        `land it, or pass force to discard it deliberately`,
    };
  }
  const [project] = await loadProjectRepos(database, projectId);
  if (!project) return { ok: false, error: `project ${projectId} has no repo path` };
  await clearIncomingRef(project.repoPath, branch);
  console.warn(
    `[worker-incoming] DISCARDED ${view.ref} at ${view.sha} ` +
      `(${view.alreadyLanded ? view.heldReason : "unreachable from any branch"}); ` +
      `the commit objects survive until git gc`,
  );
  return { ok: true, sha: view.sha };
}

/**
 * Which worker+session pushed this branch, from the newest dispatch that names it.
 * `listWorkerBranchAssignments` already sorts newest-first, so the head is the dispatch
 * that could have produced today's ref — an older, recycled `ak-<N>` must not be credited.
 */
function ownerFor(
  assignments: Array<{ workerId: string; sessionId: string; branch: string }>,
  branch: string,
): { workerId: string; sessionId: string } | null {
  const match = assignments.find((a) => a.branch === branch);
  return match ? { workerId: match.workerId, sessionId: match.sessionId } : null;
}

export interface IncomingReclaimResult extends PassReport {
  reclaimed: Array<{ projectId: string; branch: string; sha: string; reason: string }>;
  /** Held refs left in place, with the reason — the visible half of "reported and held". */
  held: Array<{ projectId: string; branch: string; reason: string; ageMs: number; stale: boolean }>;
}

/**
 * The automatic retention pass: drop incoming refs whose commit is already
 * reachable from a branch, and REPORT the rest. Nothing unreachable is ever
 * deleted here, at any age (see the retention rule at the top of this file).
 */
export async function reclaimLandedIncomingRefs(
  database: Database = realDb,
  opts: { nowMs?: number; projectId?: string } = {},
): Promise<IncomingReclaimResult> {
  const { refs } = await listIncomingRefs(database, opts);
  // One assignment read per PROJECT per pass, memoized — a sweep over a namespace with
  // twenty held refs must not become twenty identical joins.
  const assignmentsByProject = new Map<string, Promise<Awaited<ReturnType<typeof listWorkerBranchAssignments>>>>();
  const assignmentsFor = (projectId: string) => {
    let pending = assignmentsByProject.get(projectId);
    if (!pending) {
      pending = listWorkerBranchAssignments(projectId, database).catch(() => []);
      assignmentsByProject.set(projectId, pending);
    }
    return pending;
  };
  const result: IncomingReclaimResult = { ...emptyPassReport(refs.length), reclaimed: [], held: [] };
  const repoByProject = new Map<string, string>();
  for (const project of await loadProjectRepos(database, opts.projectId)) {
    repoByProject.set(project.id, project.repoPath);
  }
  for (const view of refs) {
    const repoPath = repoByProject.get(view.projectId);
    if (!repoPath) continue;
    if (view.alreadyLanded) {
      await clearIncomingRef(repoPath, view.branch);
      result.reclaimed.push({
        projectId: view.projectId,
        branch: view.branch,
        sha: view.sha,
        reason: view.heldReason ?? "already landed",
      });
      recordActed(result, view.branch, "reclaimed");
      console.log(`[worker-incoming] reclaimed ${view.ref} — ${view.heldReason}`);
      continue;
    }
    const reason = view.heldReason ?? "landable, not yet landed";
    result.held.push({
      projectId: view.projectId,
      branch: view.branch,
      reason,
      ageMs: view.ageMs,
      stale: view.stale,
    });
    // #801 — "reported and held" now leaves a durable row on the worker that pushed it,
    // beside the `ref_landed`/`ref_discarded` rows the operator actions already write.
    // A held ref is the shape of the worst fleet failure there is (an hour of an agent's
    // work sitting in a namespace nobody enumerates), and until now the only record of it
    // was the return value of this pass plus a boot log line.
    //
    // Attribution is best-effort and DELIBERATELY not a reason to skip the pass: a ref
    // with no dispatch behind it (`heldReason` = "no worker assignment") has no worker to
    // hang the event on, and inventing one would be worse than the gap.
    const owner = ownerFor(await assignmentsFor(view.projectId), view.branch);
    if (owner) {
      void recordWorkerEvent({
        database,
        workerId: owner.workerId,
        sessionId: owner.sessionId,
        type: "ref_held",
        summary: `incoming ref for ${view.branch} is held: ${reason}`,
        payload: {
          projectId: view.projectId,
          branch: view.branch,
          sha: view.sha,
          reason,
          ageMs: view.ageMs,
          stale: view.stale,
        },
      });
    }
    recordSkipped(result, view.branch, reason);
  }
  return result;
}
