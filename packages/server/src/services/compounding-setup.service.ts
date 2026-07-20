/**
 * The compounding "setup once" pass (#127).
 *
 * Every builder currently re-discovers its environment from scratch — where the code
 * lives, how to run the tests, which guards exist. The fleet analysis of the exp/
 * build-out put the median builder context at 65k tokens, rebuilt per session, most of
 * it rediscovery. Registration already scaffolds the harness, but a repo at registration
 * time is usually EMPTY: there is no layout to map, no test dir to point at, and the
 * stack profile is at its sparsest. So the useful setup can only happen later.
 *
 * This pass fills that gap. Once a project has accumulated enough merged work to have a
 * real shape, it runs the agentic setup ONCE — between tickets, not per ticket — and every
 * later builder inherits the result from the branch it forks off:
 *
 *   - hooks + verify-gate runner (idempotent re-scaffold, now that the repo has content),
 *   - lint/test feedback config regenerated from the now-populated stack profile,
 *   - the project's agent skills materialized into the main checkout,
 *   - a short, deterministic domain map (`.claude/domain-map.md`).
 *
 * ONCE is enforced by the `compounding_setup_state_<projectId>` preference, which records
 * the pass version that ran. Bumping PASS_VERSION lets an improved pass re-run everywhere
 * — that is the compounding part: an improvement to the setup propagates to every project,
 * not just to new ones.
 */

import { getPreference } from "../repositories/preferences.repository.js";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import { countMergedWorkspacesForProject } from "../repositories/workspace.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { listAgentSkills } from "../repositories/agent-skill.repository.js";
import { writeAgentSkillFile, isSafeSkillName } from "@agentic-kanban/shared/lib/agent-skill-files";
import { getStackProfile } from "./stack-profile/persistence.js";
import { writeSmartHooksRules } from "./stack-profile/smart-hooks-rules.js";
import { writeTestScaffold } from "./stack-profile/test-scaffold.js";
import { ensureHookScaffold, ensureVerifyGateRunner, commitProjectScaffoldArtifacts } from "./project-scaffold.js";
import { buildDomainMap, collectDomainMapEntries, DOMAIN_MAP_PATH } from "./compounding-setup/domain-map.js";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Version of the pass itself. Bump when the pass gains a step worth back-filling into
 * projects that already ran an older version; they re-run on the next cycle.
 */
export const PASS_VERSION = 1;

/** Default merge count at which a project is considered to have "enough code". */
export const DEFAULT_MIN_MERGES = 5;

export function compoundingSetupPrefKey(projectId: string): string {
  return `compounding_setup_${projectId}`;
}

export function compoundingSetupStatePrefKey(projectId: string): string {
  return `compounding_setup_state_${projectId}`;
}

/** Persisted record of the pass that already ran for a project. */
export interface CompoundingSetupState {
  version: number;
  ranAt: string;
  /** Merged-workspace count at the time it ran — the trigger, kept for debuggability. */
  mergedCount: number;
  /** Repo-relative paths the pass wrote or refreshed. */
  artifacts: string[];
}

export interface CompoundingSetupGate {
  enabled: boolean;
  /** Merged workspaces required before the pass runs. */
  threshold: number;
}

/**
 * Resolve the per-project gate. Pure.
 *
 * `compounding_setup_<projectId>`:
 *   - `"off"`/`"false"`  — never run for this project,
 *   - a positive number  — run at that merge threshold (per-project override),
 *   - anything else/absent — enabled at the board-wide `compounding_setup_min_merges`.
 *
 * On by default, unlike the opt-in auto-* gates: this pass only rewrites files the board
 * already owns (`.claude/**`) and its whole point is to compound across projects nobody
 * remembered to switch on. The board-wide setting at 0 turns it off everywhere.
 */
export function resolveCompoundingSetupGate(
  prefMap: Map<string, string>,
  projectId: string,
  defaultThreshold = DEFAULT_MIN_MERGES,
): CompoundingSetupGate {
  const raw = (prefMap.get(compoundingSetupPrefKey(projectId)) ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0") return { enabled: false, threshold: defaultThreshold };

  const override = Number(raw);
  if (raw !== "" && Number.isFinite(override) && override > 0) return { enabled: true, threshold: override };

  return { enabled: defaultThreshold > 0, threshold: defaultThreshold };
}

/** Read the persisted state, or null when the pass has never run (or the record is corrupt). */
export async function readCompoundingSetupState(
  projectId: string,
  database: Database = db,
): Promise<CompoundingSetupState | null> {
  const raw = await getPreference(compoundingSetupStatePrefKey(projectId), database);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CompoundingSetupState;
    return typeof parsed?.version === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** True when the pass has already run at the current version — the "once" check. */
export function isPassUpToDate(state: CompoundingSetupState | null): boolean {
  return state !== null && state.version >= PASS_VERSION;
}

/**
 * Write the domain map. Clobber-safe in the direction that matters: a map a human has
 * since edited is left alone (the generated header invites hand-extension), but a map
 * this pass itself wrote is refreshed when the pass version moves on.
 */
function writeDomainMap(repoPath: string, projectName: string, profile: Awaited<ReturnType<typeof getStackProfile>>, harnessFiles: string[]): string | null {
  try {
    const outPath = join(repoPath, ...DOMAIN_MAP_PATH.split("/"));
    const content = buildDomainMap({
      projectName,
      profile,
      entries: collectDomainMapEntries(repoPath),
      harnessFiles,
      generatedAt: new Date().toISOString(),
    });
    mkdirSync(join(outPath, ".."), { recursive: true });
    writeFileSync(outPath, content, "utf8");
    return DOMAIN_MAP_PATH;
  } catch {
    return null; // non-fatal: the map is a convenience, never a gate
  }
}

/** Materialize the project's agent skills into the main checkout so worktrees fork with them. */
async function materializeProjectSkills(projectId: string, repoPath: string, database: Database): Promise<string[]> {
  const written: string[] = [];
  try {
    const skills = await listAgentSkills(projectId, false, database);
    for (const skill of skills) {
      if (!isSafeSkillName(skill.name)) continue;
      try {
        await writeAgentSkillFile(repoPath, skill);
        written.push(`.claude/skills/${skill.name}/SKILL.md`);
      } catch {
        /* one bad skill must not abort the pass */
      }
    }
  } catch {
    /* non-fatal */
  }
  return written;
}

export interface CompoundingSetupResult {
  ran: boolean;
  /** Why the pass did not run, when `ran` is false. */
  reason?: "disabled" | "already_ran" | "not_enough_merges" | "no_repo";
  mergedCount: number;
  artifacts: string[];
}

/**
 * Run the pass for one project, unconditionally (the caller owns the gating).
 *
 * Every step is best-effort and independent: a project with no stack profile still gets
 * hooks and a domain map. The pass finishes by committing the scaffold artifacts, because
 * a main checkout left dirty by the board blocks every subsequent auto-merge on
 * `dirty_main` (#38) — the same contract registration's scaffold step honours.
 */
export async function runCompoundingSetupPass(
  projectId: string,
  repoPath: string,
  projectName: string,
  mergedCount: number,
  database: Database = db,
): Promise<CompoundingSetupResult> {
  const artifacts: string[] = [];

  try {
    ensureHookScaffold(repoPath);
    ensureVerifyGateRunner(repoPath);
    artifacts.push(".claude/hooks/", ".claude/settings.json");
  } catch {
    /* non-fatal */
  }

  const profile = await getStackProfile(projectId, database).catch(() => null);
  if (profile) {
    writeSmartHooksRules(repoPath, profile);
    artifacts.push(".claude/smart-hooks-rules.json");
    const scaffoldPath = writeTestScaffold(repoPath, profile);
    if (scaffoldPath) artifacts.push(scaffoldPath);
  }

  artifacts.push(...await materializeProjectSkills(projectId, repoPath, database));

  const mapPath = writeDomainMap(repoPath, projectName, profile, artifacts.filter((p) => p !== DOMAIN_MAP_PATH));
  if (mapPath) artifacts.push(mapPath);

  const state: CompoundingSetupState = {
    version: PASS_VERSION,
    ranAt: new Date().toISOString(),
    mergedCount,
    artifacts,
  };
  await setPreferenceChecked(database, [
    { key: compoundingSetupStatePrefKey(projectId), value: JSON.stringify(state) },
  ]);

  await commitProjectScaffoldArtifacts(repoPath);

  return { ran: true, mergedCount, artifacts };
}

/**
 * Decide and (when due) run the pass for one project. Returns why it did nothing so the
 * monitor can log a useful line instead of a silent skip.
 */
export async function maybeRunCompoundingSetup(
  projectId: string,
  gate: CompoundingSetupGate,
  database: Database = db,
): Promise<CompoundingSetupResult> {
  if (!gate.enabled) return { ran: false, reason: "disabled", mergedCount: 0, artifacts: [] };

  const state = await readCompoundingSetupState(projectId, database);
  if (isPassUpToDate(state)) return { ran: false, reason: "already_ran", mergedCount: state?.mergedCount ?? 0, artifacts: [] };

  const mergedCount = await countMergedWorkspacesForProject(projectId, database);
  if (mergedCount < gate.threshold) return { ran: false, reason: "not_enough_merges", mergedCount, artifacts: [] };

  const project = await getProjectById(projectId, database);
  if (!project?.repoPath || !existsSync(project.repoPath)) {
    return { ran: false, reason: "no_repo", mergedCount, artifacts: [] };
  }

  return runCompoundingSetupPass(projectId, project.repoPath, project.name, mergedCount, database);
}
