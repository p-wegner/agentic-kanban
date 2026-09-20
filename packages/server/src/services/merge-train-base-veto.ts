/**
 * Red-base veto for the merge-train departure window (#1204).
 *
 * MEASURED motivation: master was red on four `@gate:always-run` guard suites, and the window
 * still released a 14-member train onto it. Every bisect attempt re-assembles against the same
 * red base, so every attempt reproduces the base's own failures — train/2026-09-19-02 spent
 * **27 gate runs**, marked all 14 members `gateRejected`, and landed nothing. The defect was on
 * master; not one of the fourteen branches had anything to do with it.
 *
 * The decision is split the way the rest of this area is: `decideBaseRedVeto` is pure (the
 * facts in, a verdict out) and `resolveBaseRedVeto` is the thin reader that assembles those
 * facts from the DB and git. Nothing here re-measures the base — it reads the row
 * `base-branch-health.service.ts` already writes, so the reprobe schedule
 * (`resolveBaseHealthProbeDue`) is what clears the veto once the fix lands.
 */
import { getLatestBaseBranchHealth } from "../repositories/base-branch-health.repository.js";
import { getProjectRepoFields } from "../repositories/project.repository.js";
import * as gitService from "./git.service.js";
import type { Database } from "../db/index.js";

export interface BaseRedVetoFacts {
  /** The latest recorded base-health outcome for this project, or null when it has never been probed. */
  outcome: string | null;
  /** The sha that outcome was recorded at. */
  healthSha: string | null;
  /**
   * Has the base branch moved PAST `healthSha` since? True only when the tip is a strict
   * descendant. Unknown ancestry (no repo, an unreadable tip) is `false` — a red measurement is
   * evidence and an unanswerable git question is not a reason to discard it.
   */
  baseAheadOfHealthSha: boolean;
}

export interface BaseRedVeto {
  /** The sha the red verdict was recorded at, for the log line and the operator. */
  healthSha: string;
  /** The recorded failure summary, trimmed; empty when the row carried none. */
  message: string;
}

/**
 * Should the window HOLD instead of releasing a train?
 *
 * Only an ANSWER counts: a `timeout`/`unverified` probe learned nothing about the base
 * (`isBaseHealthAnswer`), and holding every merge on a probe that could not run is the false-red
 * failure `describeRedBaseAttribution` already refuses to commit. A base that has moved past the
 * red sha is not vetoed either — the commits since may be the fix, and the next probe is what
 * settles it.
 */
export function decideBaseRedVeto(facts: BaseRedVetoFacts, message?: string | null): BaseRedVeto | null {
  // `red` IS an answer (`isBaseHealthAnswer`), so matching it exactly is the whole check: a
  // `timeout`/`unverified` probe learned nothing and falls out here. Spelled as a literal rather
  // than by calling the repository's predicate, because a `decide*` function may not reach into
  // `repositories/` at all (`decision-function-purity.test.ts`, #585).
  if (facts.outcome !== "red") return null;
  if (!facts.healthSha) return null;
  if (facts.baseAheadOfHealthSha) return null;
  return { healthSha: facts.healthSha, message: (message ?? "").slice(0, 300) };
}

/**
 * The reader half: the project's latest base-health row plus whether its base branch has moved
 * past that row's sha. Never throws — an unreadable project or repo yields "no veto facts", and
 * the window behaves exactly as it did before #1204.
 */
export async function resolveBaseRedVeto(projectId: string, database: Database): Promise<BaseRedVeto | null> {
  const health = await getLatestBaseBranchHealth(projectId, database).catch(() => undefined);
  if (!health) return null;
  const repo = await getProjectRepoFields(projectId, database).catch(() => undefined);
  const baseAheadOfHealthSha = repo?.repoPath
    ? await isBaseAhead(repo.repoPath, repo.defaultBranch ?? health.branch, health.sha)
    : false;
  return decideBaseRedVeto(
    { outcome: health.outcome, healthSha: health.sha, baseAheadOfHealthSha },
    health.message,
  );
}

/** Strict descendant only: a tip EQUAL to the probed sha has not moved, so the red verdict stands. */
async function isBaseAhead(repoPath: string, branch: string, healthSha: string): Promise<boolean> {
  const tip = await gitService.revParse(repoPath, branch).catch(() => null);
  if (!tip || tip === healthSha) return false;
  return await gitService.isAncestor(repoPath, healthSha, tip).catch(() => false);
}
