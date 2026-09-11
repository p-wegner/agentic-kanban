import { boardStrategyPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { setPreferenceChecked, type PreferenceEntry } from "@agentic-kanban/shared/lib/checked-preference-write";
import { resolveMonitorTunables } from "@agentic-kanban/shared/lib/strategy-objective-file";
import {
  bullseyeActiveAgentsTarget,
  parseBullseyeObject,
  patchStrategyBullseyeJson,
} from "@agentic-kanban/shared/lib/strategy-bullseye-patch";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { deletePreferences, getAllPreferences } from "../repositories/preferences.repository.js";
import { getAllProjects } from "../repositories/project.repository.js";

/**
 * One-shot, idempotent startup migration (#1102): `wip_limit_<projectId>` -> the Strategy Bullseye.
 *
 * #1102 makes the Bullseye's `activeAgentsTarget` the ONLY stored per-project WIP. The per-project
 * `wip_limit_<id>` pref is retired (no longer writable), so its value has to land in the Bullseye
 * before the resolver stops reading it — otherwise a project the wizard pinned to 2 would silently
 * jump to the Bullseye's (or the default) target on the first boot after the upgrade.
 *
 * Per project, in the ticket's words:
 *  - `wip_limit_<id>` set and the Bullseye names no target -> write it into the Bullseye.
 *  - both set -> the per-project pref WINS (that is the number the monitor actually ran at, since
 *    #919 put it above the Bullseye) and overwrites the Bullseye target.
 *  - only the global `nudge_wip_limit` set -> copied into the project's Bullseye ONLY when that
 *    Bullseye already exists without a target; a project with no Bullseye keeps the default path.
 *  - then the `wip_limit_<id>` row is deleted.
 *
 * Writes go through `setPreferenceChecked`, so a Conductor project's `objective.md` regenerates
 * from the new target (this is also what closes #1101's leftover: the generated
 * ACTIVE_AGENTS_TARGET read the Bullseye and never saw `wip_limit_<id>`).
 *
 * `wip_limit_<statusId>` rows — the per-column visual limits #1102 removed — share the prefix. Only
 * keys whose suffix is a REGISTERED PROJECT id are touched; column rows stay orphaned as the ticket
 * says.
 */

const WIP_LIMIT_PREFIX = "wip_limit_";

export type WipMigrationReason =
  /** Only the per-project pref existed: a Bullseye was minted around it. */
  | "pref_only"
  /** The Bullseye existed without a target: the pref became its target. */
  | "pref_into_targetless_bullseye"
  /** Both existed: the pref (what the monitor ran at) overwrote the Bullseye target. */
  | "pref_overrides_bullseye"
  /** Both existed and already agreed: nothing to write, the pref row is just dropped. */
  | "pref_matches_bullseye"
  /** The pref held junk the resolver always ignored: the row is just dropped. */
  | "invalid_pref_dropped"
  /** Only the legacy global existed, and the Bullseye had no target. */
  | "nudge_into_targetless_bullseye";

export interface WipMigrationPlan {
  writes: Array<{ projectId: string; key: string; value: string; reason: WipMigrationReason }>;
  /** `wip_limit_<projectId>` keys to delete. */
  deletes: Array<{ projectId: string; key: string; reason: WipMigrationReason }>;
  /** Left untouched, with why — a malformed Bullseye is never overwritten. */
  skipped: Array<{ projectId: string; key: string; reason: "bullseye_malformed" }>;
}

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : null;
}

/**
 * DECISION (pure): what the migration would write and delete for this prefMap. Separated from the
 * executor so the four cases (pref-only, Bullseye-only, both, neither) are a table of cheap tests.
 */
export function planWipLimitMigration(prefMap: Map<string, string>, projectIds: readonly string[]): WipMigrationPlan {
  const plan: WipMigrationPlan = { writes: [], deletes: [], skipped: [] };
  const nudge = positiveInt(prefMap.get("nudge_wip_limit"));

  for (const projectId of projectIds) {
    const wipKey = `${WIP_LIMIT_PREFIX}${projectId}`;
    const strategyKey = boardStrategyPref.key(projectId);
    const rawBullseye = prefMap.get(strategyKey);
    const bullseye = parseBullseyeObject(rawBullseye);
    const existingTarget = bullseyeActiveAgentsTarget(rawBullseye);

    if (prefMap.has(wipKey)) {
      const pref = positiveInt(prefMap.get(wipKey));
      if (pref !== null && bullseye === "malformed") {
        // Never overwrite what we cannot read. The row stays so the value is not lost; the
        // resolver no longer reads it, which the startup log line says out loud.
        plan.skipped.push({ projectId, key: wipKey, reason: "bullseye_malformed" });
        continue;
      }
      if (pref === null) {
        plan.deletes.push({ projectId, key: wipKey, reason: "invalid_pref_dropped" });
      } else if (existingTarget === pref) {
        plan.deletes.push({ projectId, key: wipKey, reason: "pref_matches_bullseye" });
        continue;
      } else {
        const reason: WipMigrationReason = bullseye === null
          ? "pref_only"
          : existingTarget === null ? "pref_into_targetless_bullseye" : "pref_overrides_bullseye";
        // Minting a Bullseye moves `resolveMonitorTunables` off its legacy path, so carry the
        // floor and start cap the monitor was already running at instead of the Bullseye defaults.
        const legacy = resolveMonitorTunables(prefMap, projectId).tunables;
        const patched = patchStrategyBullseyeJson(rawBullseye, { activeAgentsTarget: pref }, {
          backlogFloor: legacy.backlogFloor,
          maxNewStartsPerCycle: legacy.maxNewStartsPerCycle,
        });
        if (patched.ok) plan.writes.push({ projectId, key: strategyKey, value: patched.value, reason });
        plan.deletes.push({ projectId, key: wipKey, reason });
        continue;
      }
    }

    // No usable per-project pref: the legacy global only fills a Bullseye that exists without a target.
    if (nudge !== null && bullseye !== null && bullseye !== "malformed" && existingTarget === null) {
      const patched = patchStrategyBullseyeJson(rawBullseye, { activeAgentsTarget: nudge });
      if (patched.ok) plan.writes.push({ projectId, key: strategyKey, value: patched.value, reason: "nudge_into_targetless_bullseye" });
    }
  }
  return plan;
}

export interface WipMigrationDeps {
  database?: Database;
  /** Injectable so a test can observe the writes without the objective.md regeneration side effects. */
  write?: (database: Database, entries: PreferenceEntry[]) => Promise<unknown>;
  log?: (line: string) => void;
}

/** Executor: read prefs + projects, apply {@link planWipLimitMigration}. Idempotent. */
export async function migrateWipLimitPrefsIntoBullseye(deps: WipMigrationDeps = {}): Promise<WipMigrationPlan> {
  const database = deps.database ?? db;
  const write = deps.write ?? ((d: Database, entries: PreferenceEntry[]) => setPreferenceChecked(d, entries));
  const log = deps.log ?? ((line: string) => console.log(line));

  const prefMap = toPrefMap(await getAllPreferences(database));
  const hasAnyWipKey = [...prefMap.keys()].some((key) => key.startsWith(WIP_LIMIT_PREFIX));
  if (!hasAnyWipKey && !prefMap.has("nudge_wip_limit")) return { writes: [], deletes: [], skipped: [] };

  // Archived projects too: unarchiving one must not bring back a WIP number nothing reads.
  const projectIds = (await getAllProjects(database, { includeArchived: true })).map((p) => p.id);
  const plan = planWipLimitMigration(prefMap, projectIds);

  for (const entry of plan.writes) {
    await write(database, [{ key: entry.key, value: entry.value }]);
    log(`[wip-limit-migration] ${entry.reason}: project ${entry.projectId} Bullseye activeAgentsTarget <- ${JSON.parse(entry.value).activeAgentsTarget}`);
  }
  if (plan.deletes.length > 0) {
    await deletePreferences(plan.deletes.map((d) => d.key), database);
    log(`[wip-limit-migration] deleted ${plan.deletes.length} retired wip_limit_<projectId> pref(s)`);
  }
  for (const skip of plan.skipped) {
    log(`[wip-limit-migration] KEPT ${skip.key}: the project's Bullseye is not valid JSON, so its WIP could not be moved. The value is no longer read — fix the Bullseye and set Agents on the Autopilot chip.`);
  }
  return plan;
}
