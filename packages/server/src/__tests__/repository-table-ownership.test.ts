import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * #957 — table-ownership ratchet for the repository layer.
 *
 * The repository layer grew per-CONSUMER mirror files (drive-service.repository,
 * monitor-butler.repository, handoff.repository, …) that each re-queried another
 * aggregate's table — `getProjectRepoPath` existed verbatim 3x, plus ~6
 * "load project, pluck 2-4 fields" variants. Consolidation (#957) made the
 * aggregate-owning repository the single query authority:
 *
 *  - `projects`  → repositories/project.repository.ts  (getProjectById,
 *    getProjectRepoPath, getProjectsByIds, getAllProjects, …)
 *  - `sessions`  → repositories/session.repository.ts  (getSessionStatus,
 *    getSessionStatsRaw, getSessionStats, …)
 *
 * This test scans packages/server/src/repositories/ for PRIMARY queries on those
 * tables — `from(<table>)` selects and `.insert/.update/.delete(<table>)` writes —
 * outside the owning file. JOINs are deliberately NOT counted: enriching another
 * aggregate's query with a join (`from(issues).innerJoin(projects, …)`) is a
 * legitimate single-query cross-table read, not a mirror. Ratchet-only, like
 * status-write-ratchet.test.ts (#953): existing offenders are grandfathered at
 * their current count, NEW ones are red, and stale baseline entries fail so the
 * ratchet only tightens. When you migrate a file to delegate to the owner,
 * REMOVE (or lower) its baseline entry.
 */

const repositoriesRoot = path.join(import.meta.dirname!, "..", "repositories");

/** table → the one repository file allowed to query it directly. */
const OWNERS: Record<string, string> = {
  projects: "project.repository.ts",
  sessions: "session.repository.ts",
};

/**
 * Grandfathered primary table touches outside the owner, `<file>::<table>-<kind>`
 * → count (kind: `read` = from(table), `write` = insert/update/delete(table)).
 * Only SHRINK this list — migrate the helper into the owning repository (or make
 * it delegate) and lower/remove the entry.
 */
const BASELINE: Record<string, number> = {
  // sessions reads — narrow per-consumer selects that predate #957. Each is a
  // candidate to delegate to session.repository accessors.
  "agent-questions.repository.ts::sessions-read": 1,
  "autodrive-stall-warning.repository.ts::sessions-read": 3,
  "bisect.repository.ts::sessions-read": 1,
  "board-status.repository.ts::sessions-read": 1,
  "broadcast.repository.ts::sessions-read": 1,
  "budget-estimator.repository.ts::sessions-read": 1,
  "github-handoff-draft.repository.ts::sessions-read": 1,
  "issue-activity.repository.ts::sessions-read": 1,
  "issue-service.repository.ts::sessions-read": 1,
  "issue.repository.ts::sessions-read": 1,
  "project-activity.repository.ts::sessions-read": 1,
  "review-effectiveness.repository.ts::sessions-read": 1,
  "review.repository.ts::sessions-read": 3,
  "session-lifecycle.repository.ts::sessions-read": 2,
  "session-message-pruner.repository.ts::sessions-read": 1,
  "session-stats.repository.ts::sessions-read": 1,
  "workflow-fork.repository.ts::sessions-read": 4,
  "workspace-crud.repository.ts::sessions-read": 2,
  "workspace-handoff-bundle.repository.ts::sessions-read": 1,
  "workspace-launch-failures.repository.ts::sessions-read": 1,
  "workspace-lifecycle-reconcile.repository.ts::sessions-read": 1,
  "workspace-merge.repository.ts::sessions-read": 2,
  "workspace-risk.repository.ts::sessions-read": 1,
  "workspace-scorecard.repository.ts::sessions-read": 1,
  "workspace-session.repository.ts::sessions-read": 1,
  "workspace-summary.repository.ts::sessions-read": 1,
  "workspace-timeline.repository.ts::sessions-read": 1,
  // workspace.repository.ts (2) was decomposed (#913): getCostOverTimeRows moved to
  // workspace-analytics, getWorkspaceDetails' latest-session read to workspace-reads.
  "workspace-analytics.repository.ts::sessions-read": 1,
  "workspace-reads.repository.ts::sessions-read": 1,
  // sessions writes — lifecycle/broadcast own their session mutations for now.
  "bisect.repository.ts::sessions-write": 2,
  "broadcast.repository.ts::sessions-write": 2,
  "session-lifecycle.repository.ts::sessions-write": 5,
  "workspace-lifecycle-reconcile.repository.ts::sessions-write": 1,
  "workspace-merge.repository.ts::sessions-write": 1,
  // projects writes — registration/dedup + per-project column updates. Reads are
  // fully consolidated (zero baseline); these writers are tracked to migrate.
  "project-registration.repository.ts::projects-write": 4,
  "project-service.repository.ts::projects-write": 1,
  "stack-profile.repository.ts::projects-write": 1,
};

function scanActual(): Map<string, { count: number; sites: string[] }> {
  const actual = new Map<string, { count: number; sites: string[] }>();
  const files = fs
    .readdirSync(repositoriesRoot)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

  for (const file of files) {
    const text = fs.readFileSync(path.join(repositoriesRoot, file), "utf-8");
    for (const [table, owner] of Object.entries(OWNERS)) {
      if (file === owner) continue;
      const patterns: Array<[kind: string, re: RegExp]> = [
        ["read", new RegExp(String.raw`\bfrom\(\s*${table}\s*\)`, "g")],
        ["write", new RegExp(String.raw`\.(?:insert|update|delete)\(\s*${table}\s*\)`, "g")],
      ];
      for (const [kind, re] of patterns) {
        for (const m of text.matchAll(re)) {
          const line = text.slice(0, m.index).split(/\r?\n/).length;
          const id = `${file}::${table}-${kind}`;
          const entry = actual.get(id) ?? { count: 0, sites: [] };
          entry.count += 1;
          entry.sites.push(`${file}:${line}`);
          actual.set(id, entry);
        }
      }
    }
  }
  return actual;
}

describe("repository table ownership is ratcheted to the aggregate-owning file (#957)", () => {
  const actual = scanActual();

  it("no NEW primary queries on projects/sessions outside their owning repository", () => {
    const offenders: string[] = [];
    for (const [id, { count, sites }] of actual) {
      const allowed = BASELINE[id] ?? 0;
      if (count > allowed) {
        offenders.push(`${id} (found ${count}, baseline ${allowed}):\n  ${sites.join("\n  ")}`);
      }
    }
    expect(
      offenders,
      `New primary table access outside the owning repository. Add a narrow accessor to ` +
        `project.repository.ts / session.repository.ts and delegate to it instead of ` +
        `re-querying the table:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("projects READS have zero baseline — project.repository.ts is the only projects reader", () => {
    const projectReads = [...actual.keys()].filter((id) => id.endsWith("::projects-read"));
    expect(
      projectReads,
      `repositories/ file(s) select from(projects) directly — use getProjectById / ` +
        `getProjectRepoPath / getProjectsByIds / getAllProjects from project.repository.ts`,
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
