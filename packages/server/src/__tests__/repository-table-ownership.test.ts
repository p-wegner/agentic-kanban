// @gate:always-run — ratchets table-ownership across repositories/; imports nothing it checks (#538).
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
 *    getSessionStatsRaw, getSessionStats, …) — and, since #822, the `repositories/session/`
 *    subtree that facade re-exports, because ownership is a SUBTREE, not a filename.
 *
 * This test scans packages/server/src/repositories/ RECURSIVELY for PRIMARY queries on those
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

/**
 * table → the owning SUBTREE allowed to query it directly (#822).
 *
 * Ownership is a subtree, not a filename. `session.repository.ts` is a FACADE barrel: the
 * implementation behind it was split into `repositories/session/*` by the god-module gate
 * (#875/#888/#889), so `session/lifecycle.ts` writing `sessions` is the OWNER writing its own
 * table — correct by construction, not drift. Before #822 the scan was non-recursive and never
 * saw those files at all; making it recursive without teaching it subtree ownership would have
 * grandfathered 19 legitimate owner sites as permanent debt.
 *
 * An entry ending in `/` is a directory prefix (matched against the forward-slash path relative
 * to `repositories/`); anything else is an exact relative path. `projects` has no subtree today
 * — `project.repository.ts` is also a facade, but the split it re-exports
 * (`project-status.repository.ts`) is a top-level sibling that queries `project_statuses`, not
 * `projects`, so there is nothing to own. Add `"project/"` here if that ever changes.
 */
const OWNERS: Record<string, string[]> = {
  projects: ["project.repository.ts"],
  sessions: ["session.repository.ts", "session/"],
};

/** Is `file` (a forward-slash path relative to repositories/) inside `table`'s owning subtree? */
function isOwnedBy(file: string, owners: string[]): boolean {
  return owners.some((owner) => (owner.endsWith("/") ? file.startsWith(owner) : file === owner));
}

/**
 * Grandfathered primary table touches outside the owner, `<file>::<table>-<kind>`
 * → count (kind: `read` = from(table), `write` = insert/update/delete(table)).
 * Only SHRINK this list — migrate the helper into the owning repository (or make
 * it delegate) and lower/remove the entry.
 *
 * `<file>` is the path RELATIVE to `repositories/`, forward-slashed, so a nested module reads
 * `issue/analytics.repository.ts` and collides with nothing at the top level (#822). Every
 * entry below is top-level and therefore unchanged by that spelling; the recursive scan added
 * zero new entries, because all 19 nested touches it newly sees are inside `session/**`, which
 * OWNERS now recognises as the owner.
 */
const BASELINE: Record<string, number> = {
  // sessions reads — narrow per-consumer selects that predate #957. Each is a
  // candidate to delegate to session.repository accessors.
  "agent-questions.repository.ts::sessions-read": 1,
  // #486 resolved the #483 raise: the guard now RECOGNISES a cross-aggregate join-read
  // (`isCrossAggregateJoinRead`), so those sites are no longer counted at all and their
  // baselines came back down instead of standing as permanent debt. `plugins`, `worker`,
  // `review-effectiveness` and `workspace-analytics` dropped to zero and their entries are
  // gone; `autodrive-stall-warning` went 4 → 3 (three of its four reads are joins).
  "autodrive-stall-warning.repository.ts::sessions-read": 3,
  "bisect.repository.ts::sessions-read": 1,
  "board-status.repository.ts::sessions-read": 1,
  "broadcast.repository.ts::sessions-read": 1,
  "budget-estimator.repository.ts::sessions-read": 1,
  "github-handoff-draft.repository.ts::sessions-read": 1,
  "issue-activity.repository.ts::sessions-read": 1,
  "issue-service.repository.ts::sessions-read": 1,
  "project-activity.repository.ts::sessions-read": 1,
  "review.repository.ts::sessions-read": 3,
  "session-lifecycle.repository.ts::sessions-read": 2,
  "session-message-pruner.repository.ts::sessions-read": 1,
  "session-stats.repository.ts::sessions-read": 1,
  // #722: workflow-fork.repository.ts was decomposed behind a facade barrel; its four
  // sessions reads moved together into workflow-fork-session-reads.repository.ts, so the
  // entry MOVED (same count) rather than being split across the five new modules.
  "workflow-fork-session-reads.repository.ts::sessions-read": 4,
  "workspace-crud.repository.ts::sessions-read": 2,
  "workspace-handoff-bundle.repository.ts::sessions-read": 1,
  "workspace-launch-failures.repository.ts::sessions-read": 1,
  "workspace-lifecycle-reconcile.repository.ts::sessions-read": 1,
  "workspace-merge.repository.ts::sessions-read": 2,
  "workspace-risk.repository.ts::sessions-read": 1,
  "workspace-scorecard.repository.ts::sessions-read": 1,
  "workspace-session.repository.ts::sessions-read": 1,
  "workspace-summary.repository.ts::sessions-read": 2,
  "workspace-timeline.repository.ts::sessions-read": 1,
  // workspace.repository.ts (2) was decomposed (#913): getCostOverTimeRows moved to
  // workspace-analytics, getWorkspaceDetails' latest-session read to workspace-reads.
  "workspace-reads.repository.ts::sessions-read": 1,
  // sessions writes — lifecycle/broadcast own their session mutations for now.
  "bisect.repository.ts::sessions-write": 2,
  "broadcast.repository.ts::sessions-write": 2,
  // #172 added updateSessionContainerId's write site (still in the correct owning file).
  "session-lifecycle.repository.ts::sessions-write": 6,
  "workspace-lifecycle-reconcile.repository.ts::sessions-write": 1,
  "workspace-merge.repository.ts::sessions-write": 1,
  // projects writes — registration/dedup + per-project column updates. Reads are
  // fully consolidated (zero baseline); these writers are tracked to migrate.
  "project-registration.repository.ts::projects-write": 4,
  "project-service.repository.ts::projects-write": 1,
  "stack-profile.repository.ts::projects-write": 1,
};

/**
 * #486 — does this `from(<owned table>)` start a CROSS-AGGREGATE JOIN rather than a re-query?
 *
 * The rule this guard enforces is "don't re-query another aggregate's table because you didn't
 * know its accessor existed". It already exempts the join in one direction —
 * `from(issues).innerJoin(projects, …)` is not counted, because `projects` is not the FROM.
 * It did not exempt the same query written the other way round, and that asymmetry is not a
 * real distinction: `from(sessions).innerJoin(workspaces).innerJoin(issues)` projects a value
 * across the object graph in ONE round trip. Replacing it with a narrow session accessor buys
 * either an N+1 or a whole cross-aggregate query relocated into `session.repository.ts`,
 * spreading workspace/issue knowledge into the sessions aggregate — worse than the drift being
 * guarded. Four such sites had their baselines raised in #483 for exactly this reason; this
 * makes the guard able to state the difference instead of carrying them as debt.
 *
 * Deliberately narrow: only a join appearing in the SAME statement (up to the terminating `;`)
 * exempts the read. A plain `from(sessions).where(...)` with no join is still counted, so the
 * drift the rule exists to catch stays red.
 */
function isCrossAggregateJoinRead(text: string, fromIndex: number): boolean {
  const end = text.indexOf(";", fromIndex);
  const statement = end === -1 ? text.slice(fromIndex) : text.slice(fromIndex, end);
  return /\.(?:inner|left|right|full)Join\(/.test(statement);
}

/**
 * Every `.ts` under `repositories/`, RECURSIVELY, as forward-slash paths relative to that root
 * (#822). The old `readdirSync` was non-recursive, so `repositories/issue/` and
 * `repositories/session/` — both born of god-module splits — were entirely invisible to the
 * ratchet, and every future split widened the hole.
 */
function listRepositoryFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listRepositoryFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

function scanActual(): Map<string, { count: number; sites: string[] }> {
  const actual = new Map<string, { count: number; sites: string[] }>();
  const files = listRepositoryFiles(repositoriesRoot);

  for (const file of files) {
    const text = fs.readFileSync(path.join(repositoriesRoot, file), "utf-8");
    for (const [table, owners] of Object.entries(OWNERS)) {
      if (isOwnedBy(file, owners)) continue;
      const patterns: Array<[kind: string, re: RegExp]> = [
        ["read", new RegExp(String.raw`\bfrom\(\s*${table}\s*\)`, "g")],
        ["write", new RegExp(String.raw`\.(?:insert|update|delete)\(\s*${table}\s*\)`, "g")],
      ];
      for (const [kind, re] of patterns) {
        for (const m of text.matchAll(re)) {
          if (kind === "read" && isCrossAggregateJoinRead(text, m.index!)) continue;
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
