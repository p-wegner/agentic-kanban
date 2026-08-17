// @gate:always-run — ratchets raw status-name reads across the tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * #599 — the READ-side counterpart to `status-write-ratchet.test.ts`.
 *
 * Decision 005: `issues.status` is a DERIVED legacy view. Terminal-ness comes from
 * `currentNodeId` + `nodeType` via `shared/src/lib/status-view.ts`
 * (`isTerminalStatusView`, `isWorkflowDrivenIssue`). The write side has had an authority
 * and a ratchet since #953; the read side had neither, so code kept re-deriving
 * "is this done?" by comparing the legacy string — exactly the drift decision 005 exists
 * to end. A workflow-driven issue whose node says terminal but whose legacy status string
 * has not caught up is read WRONG by every one of these comparisons.
 *
 * Ratchet, not a ban: 27 files compare raw today. Each is grandfathered at its current
 * count. A NEW comparison in any file fails; a file that drops below its baseline fails
 * as STALE so the number only goes down. Migrate to the `status-view` predicates and
 * lower (or delete) the entry.
 *
 * Scope is decision 005's four names — the terminal/initial ones whose meaning the
 * workflow can contradict. (A wider scan including "In Review"/"AI Reviewed"/"Todo"
 * finds 41 files / 87 comparisons; those are mostly presentational and not what the
 * decision is about, so they are deliberately out of scope rather than silently counted.)
 */
const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const SCAN_ROOTS = ["server/src", "shared/src", "mcp-server/src", "client/src"];

/** The status-view authority itself: it DEFINES the mapping, so it must compare literals. */
const AUTHORITY_FILES = new Set(["shared/src/lib/status-view.ts"]);

const RAW_STATUS_READ = /(===|!==)\s*["'](Done|Cancelled|In Progress|Backlog)["']/g;

/** Grandfathered raw status-name reads, `<file>` → count. Only ever lower these. */
const BASELINE: Record<string, number> = {
  "client/src/components/CompletedCard.tsx": 1,
  "client/src/components/CompletedGrid.tsx": 3,
  "client/src/components/DependencyDisplay.tsx": 3,
  "client/src/components/IssueCard.tsx": 2,
  "client/src/components/IssueMetadataGrid.tsx": 2,
  "client/src/components/MetricsView.tsx": 4,
  "client/src/components/MilestoneFilterBanner.tsx": 1,
  "client/src/components/RunQueueForecastPanel.tsx": 1,
  "client/src/lib/boardStats.ts": 2,
  "client/src/lib/issueCardDisplay.ts": 2,
  "client/src/lib/tableView-cells.ts": 2,
  "mcp-server/src/tools/contract-coupled-issues.ts": 2,
  "mcp-server/src/tools/get-board-status.ts": 3,
  "server/src/repositories/workspace-issue-status.repository.ts": 3,
  "server/src/services/board-status.ts": 3,
  "server/src/services/dependency-auto-chain.service.ts": 2,
  "server/src/services/drive-dashboard.service.ts": 1,
  "server/src/services/followup-workspace.service.ts": 1,
  "server/src/services/merge-cleanup.service.ts": 1,
  "server/src/services/plugin-loop-stall.ts": 1,
  "server/src/services/workspace-launch-failures.service.ts": 2,
  "server/src/services/workspace-risk.service.ts": 2,
  "server/src/startup/ancestor-branch-reconciler.ts": 1,
  "server/src/startup/completion-state-reconciler.ts": 1,
  "server/src/startup/exit-workflow.ts": 1,
  "shared/src/lib/drive-retro.ts": 1,
};

function sourceFiles(rel: string): string[] {
  const abs = path.join(packagesRoot, rel);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__" && e.name !== "node_modules" && e.name !== "dist") walk(full);
        continue;
      }
      if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) out.push(full);
    }
  };
  walk(abs);
  return out;
}

function currentCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(root)) {
      const rel = path.relative(packagesRoot, file).replaceAll("\\", "/");
      if (AUTHORITY_FILES.has(rel)) continue;
      const n = (fs.readFileSync(file, "utf8").match(RAW_STATUS_READ) ?? []).length;
      if (n > 0) counts[rel] = n;
    }
  }
  return counts;
}

describe("raw status-name READS are ratcheted (#599, decision 005)", () => {
  const counts = currentCounts();

  it("scans a real tree, so the ratchet cannot pass vacuously", () => {
    expect(Object.keys(counts).length).toBeGreaterThan(5);
  });

  it("no file exceeds its baseline (no NEW raw status comparisons)", () => {
    const over = Object.entries(counts)
      .filter(([file, n]) => n > (BASELINE[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} > baseline ${BASELINE[file] ?? 0}`);
    expect(
      over,
      "New raw status-name comparisons (decision 005: status is a DERIVED view).\n" +
        "Use isTerminalStatusView / isWorkflowDrivenIssue from shared/lib/status-view.ts:\n" +
        over.join("\n"),
    ).toEqual([]);
  });

  it("no baseline entry is stale (the ratchet only tightens)", () => {
    const stale = Object.entries(BASELINE)
      .filter(([file, n]) => (counts[file] ?? 0) < n)
      .map(([file, n]) => `${file}: baseline ${n}, actual ${counts[file] ?? 0} — lower or delete it`);
    expect(stale, stale.join("\n")).toEqual([]);
  });
});
