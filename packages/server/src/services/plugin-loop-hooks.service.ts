import { eq } from "drizzle-orm";
import { issues } from "@agentic-kanban/shared/schema";
import { parsePluginLoopUnitKey, parsePluginManifest, type PluginLoopDef } from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getPluginRowBySlug } from "../repositories/plugins.repository.js";

/**
 * Board-side lifecycle hooks for plugin-loop tickets (#297/#298).
 *
 * A loop ticket is recognised by its `external_key` (`plugin-loop:<slug>:<loop>:<unit>`),
 * which is already the loop engine's dedupe identity — these hooks are the first consumers
 * that read it BACK (via `parsePluginLoopUnitKey`) instead of only writing it.
 *
 * Why they exist: the pm-pipeline live run (2026-08-07) needed a manual merge and a manual
 * advance for every one of its nine steps. Loop tickets skip review by design, so nothing
 * ever set `readyForMerge`, auto-merge required a global pref that is off by default, and
 * the loop's planner (which reads the MAIN checkout) stayed blind until the merge landed —
 * at which point only the next monitor cycle (up to 4 min, Start-Mode gated) would advance.
 */

export interface LoopTicketRef {
  pluginSlug: string;
  loopName: string;
  unitId: string;
  pluginRowId: string;
  projectId: string;
  loopDef: PluginLoopDef;
}

/**
 * Resolve the loop a ticket belongs to, or null when the issue is not a loop ticket
 * (the overwhelmingly common case — one indexed select, then nothing).
 * Never throws: a malformed manifest or missing plugin row degrades to null with a warn,
 * because every caller is a best-effort tail hook that must not fail its host flow.
 */
export async function resolveLoopTicket(issueId: string, database: Database = db): Promise<LoopTicketRef | null> {
  try {
    const rows = await database
      .select({ externalKey: issues.externalKey, projectId: issues.projectId })
      .from(issues).where(eq(issues.id, issueId)).limit(1);
    const parsed = parsePluginLoopUnitKey(rows[0]?.externalKey);
    if (!parsed || !rows[0]) return null;
    const pluginRow = await getPluginRowBySlug(parsed.pluginSlug, database);
    if (!pluginRow) return null;
    const manifest = parsePluginManifest(JSON.parse(pluginRow.manifestJson));
    const loopDef = (manifest.loops ?? []).find((l) => l.name === parsed.loopName);
    if (!loopDef) return null;
    return { ...parsed, pluginRowId: pluginRow.id, projectId: rows[0].projectId, loopDef };
  } catch (err) {
    console.warn(`[plugin-loop-hooks] failed to resolve loop ticket for issue ${issueId}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** #297 — does this ticket belong to a loop that opted into auto-land? */
export async function getAutoLandLoopTicket(issueId: string, database: Database = db): Promise<LoopTicketRef | null> {
  const ref = await resolveLoopTicket(issueId, database);
  return ref?.loopDef.autoLand ? ref : null;
}

/**
 * #298 — merge-to-advance: when a loop ticket's workspace has landed, advance THAT loop
 * immediately instead of waiting for the monitor's tail phase. Runs after the main
 * checkout's working tree is synced (both merge tails call it there), which is exactly
 * when the planner can first see the merged artifacts. Serialized by the loop engine's
 * own per-loop advance lock, so racing the monitor is safe. Best-effort by contract.
 *
 * The plugin service is imported lazily: this module is reachable from the merge tails
 * and the exit workflow, and a static import would pull the whole plugin composition
 * (routes-level deps) into those startup paths.
 */
export async function advanceLoopAfterMergedIssue(issueId: string, database: Database = db): Promise<void> {
  const ref = await resolveLoopTicket(issueId, database);
  if (!ref) return;
  try {
    const { getPluginService } = await import("./plugin.service.js");
    const result = await getPluginService(database).advanceLoop(ref.pluginRowId, ref.loopName, ref.projectId);
    console.log(
      `[plugin-loop-hooks] post-merge advance of ${ref.pluginSlug}:${ref.loopName}: `
      + `planned=${result.planned} created=${result.created.length} gate=${result.gate?.id ?? "none"}`,
    );
  } catch (err) {
    // The merge already landed; a failed advance is the monitor's to retry next cycle.
    console.warn(`[plugin-loop-hooks] post-merge advance failed for issue ${issueId}:`, err instanceof Error ? err.message : String(err));
  }
}
