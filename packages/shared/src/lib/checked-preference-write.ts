/**
 * The ONE checked preference-write path (arch-review §3.3).
 *
 * A raw preference upsert has two invisible obligations that used to live only in
 * the server's `preference.service.ts`, so every OTHER writer (the MCP
 * `set_preference` tool most notably) silently skipped them:
 *
 *   1. **Provider-divergence guard (#903)** — a `provider`/`*_profile` write that
 *      would put the global prefs out of sync with the active project's Strategy
 *      Bullseye must be REJECTED before anything is persisted. The MCP side door
 *      recreated exactly the drift #903 claimed impossible.
 *   2. **objective.md regeneration** — a `board_strategy_<projectId>` write must
 *      regenerate the Conductor's git-tracked `objective.md`, or the Conductor
 *      (objective.md reader) and the in-process monitor (pref reader) end up on
 *      different tunables.
 *
 * `setPreferenceChecked` performs upsert + guard + regen in one place, driven only
 * by a drizzle handle over the shared schema, so the server settings route, the
 * CLI, and the MCP tool all go through identical logic. Node-only (the regen writes
 * files + shells git via the adapter) — reach it via the deep path
 * `@agentic-kanban/shared/lib/checked-preference-write`, never the client barrel.
 */
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { preferences, projects } from "../schema/index.js";
import * as schemaNs from "../schema/index.js";
import { parseBoolSetting } from "./settings-registry.js";
import {
  PROVIDER_DIVERGENCE_KEYS,
  resolveProviderDivergence,
  type ProviderDivergenceRejection,
} from "./strategy-policy.js";
import {
  isBoardStrategyKey,
  projectIdFromBoardStrategyKey,
  writeStrategyObjective,
  commitObjectiveFile,
  PROJECT_CONDUCTOR_OBJECTIVE_RELATIVE_PATH,
} from "./strategy-objective-file.js";
import { readRiskPosture, riskPosturePref } from "./risk-posture.js";

/** Drizzle handle over the shared schema — what both the server and MCP DBs are. */
export type PreferenceWriteDb = ReturnType<typeof drizzle<typeof schemaNs>>;

export interface PreferenceEntry {
  key: string;
  value: string;
}

export interface CheckedPreferenceWriteResult {
  /** Non-null ONLY when the divergence guard rejected the write (nothing persisted). */
  divergence: ProviderDivergenceRejection | null;
  /** Project ids whose `objective.md` was actually rewritten by this write. */
  objectivesRegenerated: string[];
}

/**
 * In-process listeners fired after `setPreferenceChecked` persists entries.
 * The server's preferences repository registers its short-TTL cache
 * invalidation here (#402), so every checked write — settings route, CLI,
 * MCP tool, plugin services — busts the cached full-table scan without this
 * shared module depending on server code.
 */
type PreferenceWriteListener = () => void;
const preferenceWriteListeners = new Set<PreferenceWriteListener>();

/** Register a post-persist listener; returns an unsubscribe function. */
export function onPreferenceWrite(listener: PreferenceWriteListener): () => void {
  preferenceWriteListeners.add(listener);
  return () => preferenceWriteListeners.delete(listener);
}

function notifyPreferenceWrite(): void {
  for (const listener of preferenceWriteListeners) {
    try {
      listener();
    } catch {
      // Listeners are best-effort cache hooks — never fail the write.
    }
  }
}

function isConductorEnabledPreference(value: string | null | undefined): boolean {
  if (!value) return false;
  if (value === "true") return true;
  try {
    const parsed = JSON.parse(value) as { enabled?: unknown };
    return parsed?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * The projects whose Strategy Bullseye the #903 divergence guard may enforce for
 * THIS write (#335, concurrency finding 3).
 *
 * The guard used to resolve against `activeProjectId` — a global, mutable
 * preference holding whatever project a human last clicked in the UI switcher. So
 * the IDENTICAL global `provider`/`*_profile` write was accepted or 422-rejected
 * depending on an unrelated project, and could be rejected because of a Bullseye
 * belonging to a project the caller never mentioned. Instead:
 *
 * - When the same write NAMES projects (it carries `board_strategy_<projectId>`
 *   entries — what the config-import path does), those are the only candidates:
 *   the write itself declares which Bullseye is authoritative.
 * - Otherwise the write names no project, so every project that HAS a Bullseye is
 *   a candidate; `unanimousDivergenceRejection` then decides whether a coherent
 *   invariant exists at all.
 */
function divergenceGuardCandidateIds(
  entries: PreferenceEntry[],
  projected: ReadonlyMap<string, string>,
): string[] {
  const named = entries
    .filter((e) => isBoardStrategyKey(e.key))
    .map((e) => projectIdFromBoardStrategyKey(e.key))
    .filter((id): id is string => Boolean(id));
  if (named.length > 0) return [...new Set(named)];
  const all = [...projected.keys()]
    .filter((key) => isBoardStrategyKey(key))
    .map((key) => projectIdFromBoardStrategyKey(key))
    .filter((id): id is string => Boolean(id));
  return [...new Set(all)];
}

/**
 * The rejection for a provider/profile write, or `null` to let it through.
 *
 * A `provider`/`claude_profile`/… preference is GLOBAL while a Bullseye is
 * per-project, so the guard can only enforce a target the candidates AGREE on.
 * When two candidates demand different provider/profile pairs the invariant is
 * unsatisfiable — no global value could ever be written — and rejecting would turn
 * a coherence guard into an unconditional block chosen by whichever projects
 * happen to hold Bullseyes. In that case the guard stands down (the passive
 * divergence banner and `GET /api/preferences/provider-divergence` still report
 * per-project drift). With exactly one distinct target — the normal case, and the
 * case #903 was written for — behaviour is unchanged: the write is rejected when it
 * would diverge from it.
 */
function unanimousDivergenceRejection(
  projected: ReadonlyMap<string, string>,
  candidateIds: string[],
): ProviderDivergenceRejection | null {
  const targets = candidateIds
    .map((projectId) => ({ projectId, result: resolveProviderDivergence(projected, projectId) }))
    .filter((t) => t.result.hasBullseye && t.result.bullseyeProvider !== null);
  if (targets.length === 0) return null;
  const distinct = new Set(targets.map((t) => `${t.result.bullseyeProvider} ${t.result.bullseyeProfile ?? ""}`));
  if (distinct.size > 1) return null;
  const first = targets[0];
  if (!first.result.diverged) return null;
  return {
    projectId: first.projectId,
    bullseyeProvider: first.result.bullseyeProvider,
    bullseyeProfile: first.result.bullseyeProfile,
    settingsProvider: first.result.settingsProvider,
    settingsProfile: first.result.settingsProfile,
  };
}

/**
 * Upsert `entries`, running the provider-divergence guard first and regenerating
 * `objective.md` for any `board_strategy_<projectId>` entry after.
 *
 * - When the guard fires, NOTHING is persisted and `divergence` is returned non-null.
 * - Callers are responsible for their own key allow-listing (the settings route's
 *   SETTINGS_KEYS whitelist, MCP's registry check); this function persists exactly
 *   the entries it is given.
 */
export async function setPreferenceChecked(
  db: PreferenceWriteDb,
  entries: PreferenceEntry[],
  options: { now?: string } = {},
): Promise<CheckedPreferenceWriteResult> {
  const now = options.now ?? new Date().toISOString();
  if (entries.length === 0) return { divergence: null, objectivesRegenerated: [] };

  // Snapshot current prefs and project the write onto them; both the guard and the
  // objective regen read from this projected view so a write that also sets, e.g.,
  // `auto_commit_strategy_objective` in the same call sees its new value.
  const rows = await db.select().from(preferences);
  const projected = new Map(rows.map((r) => [r.key, r.value]));
  for (const e of entries) projected.set(e.key, e.value);

  // 1. Write-time provider-divergence guard — only when a provider/profile key is
  //    actually touched (an unrelated toggle must never be blocked by pre-existing drift).
  if (entries.some((e) => PROVIDER_DIVERGENCE_KEYS.has(e.key))) {
    let candidateIds = divergenceGuardCandidateIds(entries, projected);
    if (candidateIds.length > 0) {
      // A `board_strategy_<id>` pref outlives its project (archive/delete does not
      // sweep it), and a phantom candidate would gate a live write against a board
      // nobody can reach. Keep only projects that exist and are not archived.
      const liveIds = new Set(
        (await db.select({ id: projects.id, archivedAt: projects.archivedAt }).from(projects))
          .filter((p) => !p.archivedAt)
          .map((p) => p.id),
      );
      candidateIds = candidateIds.filter((id) => liveIds.has(id));
    }
    const divergence = unanimousDivergenceRejection(projected, candidateIds);
    if (divergence) return { divergence, objectivesRegenerated: [] };
  }

  // 2. Persist.
  for (const { key, value } of entries) {
    await db
      .insert(preferences)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: preferences.key, set: { value, updatedAt: now } });
  }
  notifyPreferenceWrite();

  // 3. Regenerate objective.md for any board_strategy OR risk_posture write — both
  //    feed the same generated block, so either one changing must re-render it (the
  //    RISK POSTURE line would otherwise go stale on a posture-only save).
  const objectivesRegenerated: string[] = [];
  const strategyEntries = entries.filter((e) => isBoardStrategyKey(e.key));
  const postureProjectIds = entries
    .map((e) => riskPosturePref.projectIdOf(e.key))
    .filter((id): id is string => id !== null);
  const strategyProjectIds = new Set(strategyEntries.map((e) => projectIdFromBoardStrategyKey(e.key)).filter((id): id is string => id !== null));
  // A posture-only write (no accompanying board_strategy entry) still needs a regen,
  // using the project's CURRENT strategy config from `projected` rather than a raw
  // entry value.
  const postureOnlyProjectIds = postureProjectIds.filter((id) => !strategyProjectIds.has(id));

  if (strategyEntries.length > 0 || postureOnlyProjectIds.length > 0) {
    // Default ON: a Bullseye save regenerates the git-tracked objective.md, and an
    // uncommitted main checkout blocks the auto-merge queue. Opt out via the setting.
    const autoCommit = parseBoolSetting("auto_commit_strategy_objective", projected.get("auto_commit_strategy_objective"));

    const regenerate = async (projectId: string, rawConfig: string) => {
      const projectRow = (await db.select().from(projects).where(eq(projects.id, projectId)))[0];
      const repoPath = projectRow?.repoPath;
      if (!repoPath) return;
      const conductorEnabled = isConductorEnabledPreference(projected.get(`board_conductor_${projectId}`));
      const posture = readRiskPosture(projected, projectId);
      const changed = conductorEnabled
        ? writeStrategyObjective(repoPath, rawConfig, {
            objectiveRelativePath: PROJECT_CONDUCTOR_OBJECTIVE_RELATIVE_PATH,
            createIfMissing: true,
            project: projectRow,
            posture,
          })
        : writeStrategyObjective(repoPath, rawConfig, { posture });
      if (changed) objectivesRegenerated.push(projectId);
      if (changed && autoCommit && !conductorEnabled) commitObjectiveFile(repoPath);
    };

    for (const entry of strategyEntries) {
      const projectId = projectIdFromBoardStrategyKey(entry.key);
      if (!projectId) continue;
      await regenerate(projectId, entry.value);
    }
    for (const projectId of postureOnlyProjectIds) {
      await regenerate(projectId, projected.get(`board_strategy_${projectId}`) ?? "");
    }
  }

  return { divergence: null, objectivesRegenerated };
}
