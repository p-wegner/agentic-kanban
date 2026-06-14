import { eq } from "drizzle-orm";
import { projects } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { getAllPreferences, setPreferences } from "../repositories/preferences.repository.js";
import {
  getStackProfile,
  populateStackProfile,
  populateVerifyScript,
  verifyScriptPrefKey,
} from "./stack-profile.service.js";
import { HARNESS_IDS, harnessSettingKey } from "./harness-settings.js";

/**
 * One-switch "Drive this project" (#806).
 *
 * Driving a project hands-off requires a *coherent* set of preferences — not just the
 * `board_autodrive_<id>` opt-in. Set individually they drift: the project is auto-driven
 * but its per-project auto-merge kill-switch is still on, or the global review/merge
 * toggles are off, or there is no verify gate / stack profile so the harness has nothing
 * to run. This service collapses that dance into ONE coherent operation so the operator
 * flips a single switch and the board does the rest (the core operability promise of the
 * project-driver epic).
 *
 * What Drive owns (per project, unless noted GLOBAL):
 * - `board_autodrive_<id>`        — the auto-start/relaunch/refill opt-in (the keystone).
 * - `auto_merge_disabled_<id>`    — the per-project auto-merge kill-switch (cleared ON / set OFF).
 * - `auto_review` (GLOBAL)        — turned ON when driving so reviews run before merge.
 * - `auto_merge`  (GLOBAL)        — turned ON when driving so approved work actually lands.
 * - `harness.<h>.plan_auto_continue` — planMode-off: builders must not stall awaiting a plan.
 * - stack profile + `verify_script_<id>` — ensured to exist so the merge gate has something to run.
 *
 * Provider/profile is intentionally NOT owned here — that is the Strategy Bullseye's job
 * (`board_strategy_<id>`), and it is already coherent across every consumer. Drive leaves it
 * untouched so the operator's provider choice survives a triage⇄drive flip.
 *
 * Turning Drive OFF restores triage mode: the project no longer auto-starts and its
 * auto-merge kill-switch is re-armed, so nothing merges hands-off. The non-destructive
 * artifacts (stack profile, verify script, global review/merge toggles, provider) are left
 * as-is — they are equally useful for manual triage and re-enabling Drive must be cheap.
 */

export function autodrivePrefKey(projectId: string): string {
  return `board_autodrive_${projectId}`;
}

export function autoMergeDisabledPrefKey(projectId: string): string {
  return `auto_merge_disabled_${projectId}`;
}

export interface DriveStatus {
  /** Whether the single Drive switch is ON for this project. */
  enabled: boolean;
  /** Coherent breakdown of the individual settings Drive owns (for the UI / drift detection). */
  details: {
    autodrive: boolean;
    autoMergeDisabled: boolean;
    autoReview: boolean;
    autoMerge: boolean;
    hasStackProfile: boolean;
    hasVerifyScript: boolean;
  };
}

async function loadPrefMap(database: Database): Promise<Map<string, string>> {
  const rows = await getAllPreferences(database);
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** Read the current Drive status for a project. */
export async function getDriveStatus(projectId: string, database: Database): Promise<DriveStatus> {
  const prefMap = await loadPrefMap(database);
  const verify = prefMap.get(verifyScriptPrefKey(projectId));
  const enabled = prefMap.get(autodrivePrefKey(projectId)) === "true";
  return {
    enabled,
    details: {
      autodrive: enabled,
      autoMergeDisabled: prefMap.get(autoMergeDisabledPrefKey(projectId)) === "true",
      autoReview: prefMap.get("auto_review") === "true",
      autoMerge: prefMap.get("auto_merge") === "true",
      hasStackProfile: (await getStackProfile(projectId, database)) !== null,
      hasVerifyScript: !!(verify && verify.trim()),
    },
  };
}

async function resolveRepoPath(projectId: string, database: Database): Promise<string | null> {
  const rows = await database
    .select({ repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0]?.repoPath ?? null;
}

/**
 * Flip the single Drive switch for a project, setting every owned preference coherently.
 *
 * ON  → make the project build hands-off (autodrive on, kill-switch cleared, global
 *       review+merge on, planMode-off, stack profile + verify gate ensured).
 * OFF → restore triage mode (autodrive off, kill-switch re-armed). Non-destructive
 *       artifacts are preserved so re-enabling is cheap.
 */
export async function setDriveEnabled(
  projectId: string,
  enabled: boolean,
  database: Database,
): Promise<DriveStatus> {
  const entries: Array<{ key: string; value: string }> = [];

  // The keystone per-project flags — always set, both directions.
  entries.push({ key: autodrivePrefKey(projectId), value: enabled ? "true" : "false" });
  // Kill-switch is the inverse of drive: clear it ON, re-arm it OFF.
  entries.push({ key: autoMergeDisabledPrefKey(projectId), value: enabled ? "false" : "true" });

  if (enabled) {
    // The drive needs the global review→merge pipeline live; without these the project is
    // auto-driven but nothing ever reviews or lands. They are global, but turning them ON
    // is non-destructive (other projects benefit; a project opts out via its kill-switch).
    entries.push({ key: "auto_review", value: "true" });
    entries.push({ key: "auto_merge", value: "true" });
    // planMode-off: a driven builder must implement, not stall waiting for a plan to be
    // continued. Enable auto-continue for every harness.
    for (const harness of HARNESS_IDS) {
      entries.push({ key: harnessSettingKey(harness, "plan_auto_continue"), value: "true" });
    }

    // Ensure the harness has a stack profile + verify gate to run. Both are idempotent and
    // non-destructive (never clobber an existing profile/override). Best-effort: a detection
    // failure must not block enabling Drive.
    const repoPath = await resolveRepoPath(projectId, database);
    if (repoPath) {
      let profile = await getStackProfile(projectId, database);
      if (!profile) {
        try {
          // skipLlm: enabling Drive must be fast and offline-safe; the rule-based profile is
          // enough to seed a verify gate, and the user can Re-detect for LLM enrichment.
          profile = await populateStackProfile(projectId, repoPath, database, { skipLlm: true });
        } catch {
          profile = null;
        }
      }
      try {
        await populateVerifyScript(projectId, repoPath, database, profile);
      } catch {
        // verify-gate derivation is best-effort — leave unset on failure (safe no-op).
      }
    }
  }

  await setPreferences(entries, database);
  return getDriveStatus(projectId, database);
}
