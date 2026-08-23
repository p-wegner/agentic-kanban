// @gate:always-run — ratchets raw status writes across the tree; imports nothing it checks (#538).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * #953 — ratchet gate against raw status writes outside the transition authorities.
 *
 * Issue status and workspace status each have ONE write authority:
 *  - `transitionIssueStatus` (@agentic-kanban/shared/lib/workflow-engine/status-transition.ts)
 *    writes statusId + stamps statusChangedAt + syncs the workflow current-node
 *    (the #537 end-node check silently re-broke every time a raw writer skipped the sync).
 *  - `setWorkspaceStatus` (server/src/repositories/workspace-status.repository.ts)
 *    enforces the terminal invariant (closed+mergedAt may not be revived) and logs
 *    failures instead of blind `.catch(() => {})`.
 *
 * This test scans server + mcp-server src for raw `update(issues).set({... statusId ...})`
 * and `update(workspaces).set({... status ...})` shapes (plus opaque `.set(<variable>)`
 * writes to those tables, which could hide a status write) and fails when a file
 * EXCEEDS the checked-in baseline. Existing writers are grandfathered explicitly;
 * NEW raw writers are red. Pattern: ratchet-only, like pref-polarity-ratchet.test.ts (#947).
 *
 * When you migrate a file's raw writes to the authority, REMOVE (or lower) its
 * baseline entry — the test also fails on stale entries, so the ratchet only tightens.
 *
 * #967 drained every migratable `workspaces-status`/`workspaces-opaque-set` raw writer
 * (mcp-server close/stop-workspace, session-lifecycle, workflow-fork, workspace-session,
 * workspace-lifecycle-reconcile, and the status-carrying branches of workspace-crud) to
 * `setWorkspaceStatus` — which moved to `@agentic-kanban/shared/lib/workspace-status` so
 * both server and mcp-server share the one guarded authority. What remains grandfathered
 * is either a genuine shape mismatch (issue-service's bulk multi-row close) or a proven
 * false positive of the opaque-`.set(var)` heuristic (no `status` field in the value type
 * at all — scorecard/summary caches, `setWorkspaceWorkingDir`).
 */

const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const scanRoots = [
  path.join(packagesRoot, "server", "src"),
  path.join(packagesRoot, "mcp-server", "src"),
];

/** The workspace-status authority module itself (relative, forward slashes). */
const AUTHORITY_FILES = new Set([
  "server/src/repositories/workspace-status.repository.ts",
]);

/**
 * Grandfathered raw status writes, `<file>::<category>` → count. Categories:
 *  - `issues-statusId`        literal `.set({ ... statusId ... })` on update(issues)
 *  - `workspaces-status`      literal `.set({ ... status ... })` on update(workspaces)
 *  - `issues-opaque-set`      `.set(<variable>)` on update(issues) — could carry statusId
 *  - `workspaces-opaque-set`  `.set(<variable>)` on update(workspaces) — could carry status
 * Only SHRINK this list.
 */
const BASELINE: Record<string, number> = {
  // #501: `contract-coupled-issues.ts::issues-statusId` is GONE — the absorbed-issue
  // terminal status now goes through `transitionIssueStatus`, so mcp-server has no literal
  // raw issue-status write left.
  //
  // `update_issue` still does `.set(updates)` with an opaque variable, so the heuristic
  // still sees it and the entry has to stay — but it is now a PROVABLE non-status write:
  // #501 removed `statusId`/`statusChangedAt` from that object and routed the status
  // through `transitionIssueStatus`. Same category of false positive as the
  // workspace-crud/scorecard entries below, kept for the same reason.
  "mcp-server/src/tools/update-issue.ts::issues-opaque-set": 1,
  "server/src/repositories/issue-service.repository.ts::issues-opaque-set": 2,
  "server/src/repositories/issue-service.repository.ts::issues-statusId": 1,
  // Bulk multi-row `update(workspaces).set({status:"closed",...}).where(status != 'closed')`
  // across every open workspace of one issue — `setWorkspaceStatus` operates on a single
  // workspaceId, so this doesn't fit the authority's signature without an extra
  // select-then-loop. Left grandfathered; #967 migrated every single-row raw writer.
  "server/src/repositories/issue-service.repository.ts::workspaces-status": 1,
  "server/src/repositories/project-registration.repository.ts::issues-statusId": 1,
  // `setWorkspaceWorkingDir` (workingDir/baseBranch only) + the non-status branch of
  // `applyWorkspaceUpdates` (#967 routes the status-carrying branch through
  // `setWorkspaceStatus`) — both provably carry no `status` column; the opaque-`.set(var)`
  // heuristic can't see that statically, so they stay grandfathered rather than migrated.
  "server/src/repositories/workspace-crud.repository.ts::workspaces-opaque-set": 2,
  // `workspace-scorecard.repository.ts::workspaces-opaque-set` is GONE, not zeroed.
  // `persistScorecard` was a provable non-status write (`{scorecardScore, scorecardJson,
  // scorecardComputedAt}`) that only the opaque-`.set(var)` heuristic flagged; #815's
  // migration 0143 moved those three columns to `workspace_scorecard`, so it no longer
  // writes `workspaces` at all. Same story as the summary repo above.
  // `workspace-summary.repository.ts::workspaces-opaque-set` is GONE, not zeroed. It was 2
  // (`updateWorkspaceConflictCache` + `updateWorkspaceDiffStatCache`), then 1 when #815's
  // migration 0139 moved the conflict memo to its own table, and now 0: migration 0142 moved
  // the diff-stat memo to `workspace_diff_stat_cache`, so that file writes `workspaces`
  // nowhere at all and holds reads only. An entry of 0 would be a claim about a writer that
  // no longer exists there — and this ratchet fails on stale entries, which is what forces
  // the removal to happen in the same commit as the extraction.
};

/** #583 — the tree walk every guard suite needs, from the one shared helper. */
const listTsFiles = (dir: string): string[] => walkPackageSources(dir);

const UPDATE_SET_RE =
  /update\(\s*(?:schema\.)?(issues|workspaces)\s*\)\s*\.\s*set\(\s*(\{[\s\S]*?\}|[A-Za-z_$][\w$.]*)\s*[),]/g;

/** Categorize one `update(<table>).set(<arg>)` occurrence, or null if benign. */
function classify(table: string, setArg: string): string | null {
  if (setArg.startsWith("{")) {
    if (table === "issues" && /\bstatusId\b\s*[:,}]/.test(setArg)) return "issues-statusId";
    if (table === "workspaces" && /\bstatus\b\s*[:,}]/.test(setArg)) return "workspaces-status";
    return null;
  }
  return `${table}-opaque-set`;
}

function scanActual(): Map<string, { count: number; sites: string[] }> {
  const actual = new Map<string, { count: number; sites: string[] }>();
  for (const root of scanRoots) {
    if (!fs.existsSync(root)) continue;
    for (const file of listTsFiles(root)) {
      const rel = path.relative(packagesRoot, file).replace(/\\/g, "/");
      if (AUTHORITY_FILES.has(rel)) continue;
      const text = fs.readFileSync(file, "utf-8");
      for (const m of text.matchAll(UPDATE_SET_RE)) {
        const category = classify(m[1]!, m[2]!);
        if (!category) continue;
        const line = text.slice(0, m.index).split(/\r?\n/).length;
        const id = `${rel}::${category}`;
        const entry = actual.get(id) ?? { count: 0, sites: [] };
        entry.count += 1;
        entry.sites.push(`${rel}:${line}`);
        actual.set(id, entry);
      }
    }
  }
  return actual;
}

describe("raw status writes are ratcheted behind the transition authorities (#953)", () => {
  const actual = scanActual();

  it("no NEW raw issue-statusId / workspace-status writes beyond the baseline", () => {
    const offenders: string[] = [];
    for (const [id, { count, sites }] of actual) {
      const allowed = BASELINE[id] ?? 0;
      if (count > allowed) {
        offenders.push(`${id} (found ${count}, baseline ${allowed}):\n  ${sites.join("\n  ")}`);
      }
    }
    expect(
      offenders,
      `New raw status write(s). Use transitionIssueStatus (@agentic-kanban/shared/lib/workflow-engine) ` +
        `for issue statusId, or setWorkspaceStatus (repositories/workspace-status.repository.ts) ` +
        `for workspace status, instead of raw db.update():\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("baseline entries are not stale (ratchet down when a file is migrated)", () => {
    const stale: string[] = [];
    for (const [id, allowed] of Object.entries(BASELINE)) {
      const count = actual.get(id)?.count ?? 0;
      if (count < allowed) stale.push(`${id}: baseline ${allowed}, found ${count} — lower/remove the entry`);
    }
    expect(stale, `Stale baseline entries (nice work — tighten the ratchet):\n${stale.join("\n")}`).toEqual([]);
  });
});
