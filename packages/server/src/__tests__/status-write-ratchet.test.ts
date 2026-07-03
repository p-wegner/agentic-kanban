import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

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
  "mcp-server/src/tools/close-workspace.ts::workspaces-status": 1,
  "mcp-server/src/tools/contract-coupled-issues.ts::issues-statusId": 1,
  "mcp-server/src/tools/stop-workspace.ts::workspaces-status": 1,
  "mcp-server/src/tools/update-issue.ts::issues-opaque-set": 1,
  "server/src/repositories/issue-service.repository.ts::issues-opaque-set": 2,
  "server/src/repositories/issue-service.repository.ts::issues-statusId": 1,
  "server/src/repositories/issue-service.repository.ts::workspaces-status": 1,
  "server/src/repositories/project-registration.repository.ts::issues-statusId": 1,
  "server/src/repositories/session-lifecycle.repository.ts::workspaces-status": 3,
  "server/src/repositories/workflow-fork.repository.ts::workspaces-status": 3,
  "server/src/repositories/workspace-crud.repository.ts::workspaces-opaque-set": 4,
  "server/src/repositories/workspace-lifecycle-reconcile.repository.ts::workspaces-opaque-set": 1,
  "server/src/repositories/workspace-scorecard.repository.ts::workspaces-opaque-set": 1,
  "server/src/repositories/workspace-session.repository.ts::workspaces-status": 2,
  "server/src/repositories/workspace-summary.repository.ts::workspaces-opaque-set": 2,
};

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...listTsFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

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
