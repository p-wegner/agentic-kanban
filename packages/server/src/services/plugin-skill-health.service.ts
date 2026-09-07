import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { listEnabledPlugins } from "./plugin-enabled.js";
import { fanOutPluginSkills, type EnableReport } from "./plugin-enablement.service.js";

export interface PluginSkillHealthFinding {
  pluginSlug: string;
  pluginName: string;
  skillName: string;
  reason: string;
}

export interface PluginSkillHealthReport {
  /** Skills the main checkout had lost, that this check just re-created there. */
  healed: PluginSkillHealthFinding[];
  /** Skills enabled on paper that could not be materialized at all (source gone too). */
  missing: PluginSkillHealthFinding[];
}

/**
 * Re-run the enable-time skill fan-out for every plugin ENABLED on `projectId`, against the
 * project's OWN `repoPath` (the MAIN checkout) — never a worktree.
 *
 * #1039 fixed this healing at workspace-PROVISIONING time (`materializeEnabledPluginSkills`),
 * but that only runs when a workspace is actually created — so a junction that goes missing on
 * a board with no in-flight workspace creation (the exact #1053 shape: the checkout moved, the
 * dir was hand-deleted, a pref flipped without the enable action) stayed broken with nothing
 * ever noticing, until an agent happened to start a new workspace against it. This is the same
 * fan-out (`fanOutPluginSkills` is idempotent — an existing, resolving target is
 * `skipped-existing`), callable independently of provisioning so a caller that has no worktree
 * in flight (a risk digest, a periodic sweep) can still check and self-heal.
 */
export async function checkPluginSkillHealth(
  projectId: string,
  repoPath: string,
  database: Database = db,
): Promise<PluginSkillHealthReport> {
  const result: PluginSkillHealthReport = { healed: [], missing: [] };
  for (const { row, manifest } of await listEnabledPlugins(projectId, database)) {
    const report: EnableReport = {
      prefKey: "",
      skills: [],
      scaffoldWritten: false,
      scaffoldPlaceholders: 0,
      warnings: [],
    };
    fanOutPluginSkills({ localPath: row.localPath, manifest }, repoPath, report);
    for (const skill of report.skills) {
      if (skill.mode === "missing-source") {
        result.missing.push({
          pluginSlug: row.pluginId,
          pluginName: row.name,
          skillName: skill.name,
          reason: report.warnings.find((w) => w.includes(skill.name)) ?? "skill dir not found in plugin",
        });
      } else if (skill.mode === "junction" || skill.mode === "copy") {
        // The target did not resolve a moment ago, or this call would have seen
        // `skipped-existing` instead — a link/copy here means it just went missing and this
        // check is what caught it, not a routine first-time materialization (that already
        // happened at enable time, via the SAME function called from a different site).
        result.healed.push({
          pluginSlug: row.pluginId,
          pluginName: row.name,
          skillName: skill.name,
          reason: `re-materialized (${skill.mode}) — it was missing from this checkout`,
        });
      }
    }
  }
  return result;
}
