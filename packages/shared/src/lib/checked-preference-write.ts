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
    const activeProjectId = projected.get("activeProjectId");
    if (activeProjectId) {
      const result = resolveProviderDivergence(projected, activeProjectId);
      if (result.hasBullseye && result.diverged) {
        return {
          divergence: {
            projectId: activeProjectId,
            bullseyeProvider: result.bullseyeProvider,
            bullseyeProfile: result.bullseyeProfile,
            settingsProvider: result.settingsProvider,
            settingsProfile: result.settingsProfile,
          },
          objectivesRegenerated: [],
        };
      }
    }
  }

  // 2. Persist.
  for (const { key, value } of entries) {
    await db
      .insert(preferences)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: preferences.key, set: { value, updatedAt: now } });
  }

  // 3. Regenerate objective.md for any board_strategy write.
  const objectivesRegenerated: string[] = [];
  const strategyEntries = entries.filter((e) => isBoardStrategyKey(e.key));
  if (strategyEntries.length > 0) {
    // Default ON: a Bullseye save regenerates the git-tracked objective.md, and an
    // uncommitted main checkout blocks the auto-merge queue. Opt out via the setting.
    const autoCommit = parseBoolSetting("auto_commit_strategy_objective", projected.get("auto_commit_strategy_objective"));
    for (const entry of strategyEntries) {
      const projectId = projectIdFromBoardStrategyKey(entry.key);
      if (!projectId) continue;
      const projectRow = (await db.select().from(projects).where(eq(projects.id, projectId)))[0];
      const repoPath = projectRow?.repoPath;
      if (!repoPath) continue;
      const conductorEnabled = isConductorEnabledPreference(projected.get(`board_conductor_${projectId}`));
      const changed = conductorEnabled
        ? writeStrategyObjective(repoPath, entry.value, {
            objectiveRelativePath: PROJECT_CONDUCTOR_OBJECTIVE_RELATIVE_PATH,
            createIfMissing: true,
            project: projectRow,
          })
        : writeStrategyObjective(repoPath, entry.value);
      if (changed) objectivesRegenerated.push(projectId);
      if (changed && autoCommit && !conductorEnabled) commitObjectiveFile(repoPath);
    }
  }

  return { divergence: null, objectivesRegenerated };
}
