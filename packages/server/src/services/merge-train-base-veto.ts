/**
 * Red-base veto for the merge-train departure window (#1204, posture-aware since #1233).
 *
 * MEASURED motivation: master was red on four `@gate:always-run` guard suites, and the window
 * still released a 14-member train onto it. Every bisect attempt re-assembles against the same
 * red base, so every attempt reproduces the base's own failures — train/2026-09-19-02 spent
 * **27 gate runs**, marked all 14 members `gateRejected`, and landed nothing. The defect was on
 * master; not one of the fourteen branches had anything to do with it.
 *
 * MEASURED counter-motivation (#1233, 2026-09-24): the base only moves through trains, so a red
 * nightly sweep under a `block` policy held every train until a human hand-landed a fix on the
 * base — and under `iterate` that policy also filed no heal ticket, so nothing on the board said
 * why the window was frozen. The veto therefore reads the project's EFFECTIVE `redBasePolicy`
 * (decision 017's one dial, through `resolveRiskPosture` — never the raw pref) and holds only
 * under `block`. Every softer policy reports the red instead: `allow-file-debt-ticket` through
 * the heal ticket the sweep files (`base-health-heal-ticket.service.ts`), `report` through the
 * delivery view alone. The control arm in `merge-train.service.ts` (one bare-base gate run
 * before a bisect blames a member) is a different question and stays under every posture.
 *
 * The decision is split the way the rest of this area is: `decideBaseRedVeto` is pure (the
 * facts in, a verdict out) and `resolveBaseRedVeto` is the thin reader that assembles those
 * facts from the DB and git. Nothing here re-measures the base — it reads the row
 * `base-branch-health.service.ts` already writes, so the reprobe schedule
 * (`resolveBaseHealthProbeDue`) is what clears the veto once the fix lands.
 *
 * NOT done (#1233's optional refinement): narrowing a `block` hold to the case where the sweep's
 * failing suites intersect the train's changed files or the guards those files map to. The
 * data for it (the impact map, the `when:` globs of `always-run-guard-floor.ts`, a diff per
 * pending workspace) is spread across three modules and a gitignored artifact, and a wrong
 * intersection would release a train onto exactly the red it was meant to avoid. The posture
 * switch alone answers the measured problem; `BaseRedVetoFacts` is the seam a refinement would
 * extend.
 */
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import type { RedBasePolicy } from "@agentic-kanban/shared/types";
import { getLatestBaseBranchHealth } from "../repositories/base-branch-health.repository.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { getProjectRepoFields } from "../repositories/project.repository.js";
import * as gitService from "./git.service.js";
import { resolveRiskPosture, type RiskPosture } from "./risk-posture.service.js";
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
  /**
   * The project's EFFECTIVE red-base policy (#1233) — `RiskPosture.redBasePolicy` after the
   * softer-only project override. Only `block` holds the window; every other value reports.
   */
  redBasePolicy: RedBasePolicy;
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
 * settles it. And a policy other than `block` never holds (#1233): the red is disclosed through
 * the heal ticket or the delivery view rather than by freezing the only road onto the base.
 */
export function decideBaseRedVeto(facts: BaseRedVetoFacts, message?: string | null): BaseRedVeto | null {
  if (facts.redBasePolicy !== "block") return null;
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
 * The reader half: the project's latest base-health row, whether its base branch has moved
 * past that row's sha, and the project's effective red-base policy. Never throws — an
 * unreadable project or repo yields "no veto facts", and the window behaves exactly as it did
 * before #1204.
 *
 * `posture` is optional so a caller that already resolved one (the orchestrator, which reads it
 * for the train window's size and wait) does not pay a second preference read; absent, it is
 * resolved here through the one sanctioned reader.
 */
export async function resolveBaseRedVeto(
  projectId: string,
  database: Database,
  opts: { posture?: RiskPosture } = {},
): Promise<BaseRedVeto | null> {
  const health = await getLatestBaseBranchHealth(projectId, database).catch(() => undefined);
  if (!health) return null;
  const posture = opts.posture ?? resolveRiskPosture(
    toPrefMap(await getAllPreferencesCached(database).catch(() => [])),
    projectId,
  );
  if (posture.redBasePolicy !== "block") {
    if (health.outcome === "red") {
      console.log(
        `[merge-train-base-veto] project ${projectId}: base is red at ${health.sha.slice(0, 8)} but `
          + `redBasePolicy '${posture.redBasePolicy}' (risk posture '${posture.level}') reports rather than holds — `
          + `the train window may depart (#1233)`,
      );
    }
    return null;
  }
  const repo = await getProjectRepoFields(projectId, database).catch(() => undefined);
  const baseAheadOfHealthSha = repo?.repoPath
    ? await isBaseAhead(repo.repoPath, repo.defaultBranch ?? health.branch, health.sha)
    : false;
  return decideBaseRedVeto(
    { outcome: health.outcome, healthSha: health.sha, baseAheadOfHealthSha, redBasePolicy: posture.redBasePolicy },
    health.message,
  );
}

/** Strict descendant only: a tip EQUAL to the probed sha has not moved, so the red verdict stands. */
async function isBaseAhead(repoPath: string, branch: string, healthSha: string): Promise<boolean> {
  const tip = await gitService.revParse(repoPath, branch).catch(() => null);
  if (!tip || tip === healthSha) return false;
  return await gitService.isAncestor(repoPath, healthSha, tip).catch(() => false);
}
