// @gate:always-run — reads source files it does not import; invisible to `vitest related`.
/**
 * The #728 split-responsibility remainder may only SHRINK.
 *
 * #728 lists 95 production files that carry a responsibility-split prescription — each one
 * a bridge between clusters AND internally heavy, and every one of them UNDER the 1000-line
 * god-module ceiling, so none is visible to `scripts/check-god-modules.mjs`. That
 * invisibility is the ticket's whole point, and it is also what makes a partial fix
 * dangerous: nothing would stop a split file from re-absorbing its halves, or the named
 * remainder from growing.
 *
 * This is that stop. It counts TOP-LEVEL DECLARATIONS — the load-bearing number, since the
 * ticket's subject is how many distinct things one module declares, not how long it is — for
 * the five files #728 named as its top candidates plus the modules they were split into, and
 * fails when one grows. All five are now split: three in #728 batch 1, and
 * `devcontainer-workspace` + `butler-definitions` in #819 batch 2.
 *
 * ## What it does NOT cover, said plainly
 *
 * The other 90 candidates. Their identity comes from `code-metrics refactor analysis.json
 * --move split_responsibility`, which is an external tool run against a whole-repo analysis;
 * this suite cannot re-derive that list, so it cannot ratchet it. **#819 tracks the
 * remainder.** Treat a green run here as "the five named files did not get worse", never as
 * "the ticket is handled".
 *
 * ## Adjusting a baseline
 *
 * Lowering one is a one-line edit and is expected after every further split. RAISING one is
 * the thing this suite exists to make deliberate: if a file genuinely needs another
 * declaration, say why in the commit — you are spending the ticket's budget, not resetting it.
 * A count BELOW its baseline also fails ("lower it"), so a baseline can never quietly become
 * a budget.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { compareRatchet } from "../../../shared/__tests__/helpers/guard-scan.js";

const SERVER_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Top-level declaration counts, keyed by path relative to `packages/server/src`.
 *
 * Every entry is a post-split count, pinned so a half cannot drift back into the module it
 * came from. Each split carries, beside its entry, the CONSUMER argument that justified the
 * seam — because that is what a future agent needs before cutting the next candidate, and
 * because #728 found that 2 of 3 tool-computed seams were clustering artifacts of identifier
 * vocabulary rather than responsibilities.
 */
const BASELINE: Record<string, number> = {
  // --- split in #728 batch 1: pinned so the extracted halves cannot return ---
  "services/workspace-services.service.ts": 10,
  "services/workspace-services/compose-runner.ts": 4,
  "repositories/issue.repository.ts": 22,
  "repositories/issue/analytics.repository.ts": 4,
  "repositories/issue/touched-files.repository.ts": 4,
  "services/git-info.service.ts": 0,
  "services/git-info/repo-detect.ts": 6,
  "services/git-info/project-stats.ts": 32,

  // --- split in #819 batch 2 ---
  // devcontainer-workspace: 22 -> 17 + 5. Cut along CONSUMERS, not the tool's computed
  // seams (`dockerexec` / `worktreepath` / `source` — an imported function, a parameter
  // name and a JSON field). The teardown paths (workspace-cleanup, workspace-create,
  // workspace-resource-release) import only `reapWorkspaceContainer`; the provisioning
  // consumers (workspace-provision, session-manager/devcontainer-launch, startup-tasks,
  // agent-dispatch) import nothing from the inventory half. One-way edge, no cycle, and
  // the file had no module-level mutable state to tear.
  "services/devcontainer-workspace.service.ts": 17,
  "services/devcontainer-workspace/container-inventory.ts": 5,
  // butler-definitions: 21 -> 0 (facade) + 12 + 9. #728 called this seam real but
  // DEFERRED the cut ("the smallest of the five and the cheapest to read as-is"). The
  // consumer check that reopened it: the CRUD route (routes/butler-definitions.ts)
  // imports only the store half, the two headless warm-up callers
  // (services/agent-questions/recommendation.ts, services/plugin-gate-butler.service.ts)
  // import only resolveButlerLaunchConfig, and the sets overlap in exactly one module
  // (routes/butler.ts) which legitimately does both. The decisive argument is import
  // weight, not line count: launch-config pulls in agent settings, the Strategy Bullseye
  // reader, the shared provider resolver, the preference service and the codex license
  // ring; the store needs a preference read/write and a slugifier. Keeping them together
  // made a four-endpoint CRUD route transitively depend on the whole provider-resolution
  // stack. The edge runs one way (launch-config reads a definition; the store calls
  // nothing back), so the service file is now a pure facade and scores 0.
  "services/butler-definitions.service.ts": 0,
  "services/butler-definitions/definitions-store.ts": 12,
  "services/butler-definitions/launch-config.ts": 9,

  // --- split in #831 batch 3 (re-derived from a fresh code-metrics run — see below) ---
  // insights.service.ts: 45 fns -> the DB-touching orchestrator (computeInsights/
  // parseRange/types) + a pure single-pass aggregation engine. Consumer evidence, not
  // just naming: `insights-accumulator.test.ts` already imported ONLY
  // createInsightsAccumulator/accumulateInsightsRow (built its own rows by hand, no
  // database), while `routes/insights.ts` imports only computeInsights/parseRange and
  // never reaches the accumulator internals — disjoint consumer sets. The module's own
  // pre-existing comment on InsightsAccumulator already claimed the split was safe
  // ("split out so the aggregation is unit-testable without a database"); this makes
  // that claim physically true instead of aspirational.
  //
  // The extraction itself needed a THIRD cut: pulling the accumulator machinery out of
  // insights.service.ts in one piece landed 21 top-level function/class declarations in
  // accumulator.ts, one over the god-module gate's flat 20-declaration ceiling (#889).
  // The eight per-dimension fold functions (accumulateFriction, accumulateSkillBucket,
  // …) — independent, single-caller writers with no fan-in among themselves — moved to
  // dimension-folds.ts, and the shared bucket types + pure primitives (parseStats,
  // applyAggregate, createAggregateBucket, the date-math helpers) moved to types.ts to
  // break the two-file import cycle that would otherwise exist between accumulator.ts
  // and dimension-folds.ts. accumulator.ts now holds only accumulateInsightsRow and its
  // private deriveSessionRowFacts helper.
  "services/insights.service.ts": 6,
  "services/insights/accumulator.ts": 3,
  "services/insights/types.ts": 25,
  "services/insights/dimension-folds.ts": 8,
};

/**
 * ## #831 note: how the other ~89 remaining candidates were triaged
 *
 * #819's cached `analysis.json` was too shallow to drive `--move split_responsibility`
 * (zero function counts on every file entry, so the detector's preconditions could never
 * fire). The MAIN CHECKOUT already held a deep run (`code-metrics-out/analysis.json`,
 * dated 2026-08-24) with real function/CC/LCOM data — copied into this worktree rather
 * than re-run, since the machine was RAM-critical (0.7 GB usable, actively swapping) when
 * this ticket ran. Re-deriving with `code-metrics refactor analysis.json --move
 * split_responsibility` against that deep run returns 175 opportunities across 59 unique
 * files — a different set from #728's original 95, because the tree has moved.
 *
 * Reading several of those 59 by CONSUMERS (not the tool's identifier-vocabulary seams)
 * found most are NOT genuine split candidates:
 *  - Already-split facades the tool still flags on residual size
 *    (`devcontainer-workspace.service.ts`, `butler-definitions/launch-config.ts`,
 *    `workspace-services.service.ts`, `plugin-fs.ts` — the last is itself an extraction
 *    already, per its own header comment).
 *  - Small (100-300 line) factory-shaped services where "many functions" is one closure's
 *    private helpers around a handful of exported operations, not a bridge between
 *    disjoint consumer groups (`plugin-enabled.ts`, `onboarding.service.ts`,
 *    `service-stack-reaper.ts` all checked directly — genuinely cohesive, no disjoint
 *    consumer sets found).
 *
 * `insights.service.ts` above is the one file checked so far with a real, evidence-backed
 * seam. The remainder (most of the 59) has NOT been individually verified by consumers —
 * doing that exhaustively (one file per commit, per the ticket's own mechanics) is a
 * multi-session effort this run did not have budget to finish. Filed as a follow-up:
 * see #728/#819/#831's tracking chain — file the next slice against the same chain rather
 * than re-deriving the list from scratch, since the file set moves every time the tree
 * does. A future agent re-running the `--move split_responsibility` command should expect
 * a still-different list than either 95 or 59, and must re-verify by consumers again
 * rather than trusting either historical count.
 */

/**
 * Every top-level declaration in a module: functions, classes, interfaces, type aliases,
 * enums, and each name bound by a top-level `const`/`let`/`var`.
 *
 * Re-export statements are deliberately NOT counted. A facade that re-exports its halves
 * (`git-info.service.ts` is one, and scores 0 here) has taken responsibility OUT of itself,
 * which is the outcome this ticket wants — counting the re-exports would score it as if
 * nothing had moved.
 */
function countTopLevelDeclarations(absFile: string): number {
  const text = readFileSync(absFile, "utf8");
  const sf = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let n = 0;
  for (const stmt of sf.statements) {
    if (
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      n += 1;
    } else if (ts.isVariableStatement(stmt)) {
      n += stmt.declarationList.declarations.length;
    }
  }
  return n;
}

describe("#728 split-responsibility remainder (shrink-only)", () => {
  it("no named candidate declares more than its baseline", () => {
    const current: Record<string, number> = {};
    for (const rel of Object.keys(BASELINE)) {
      current[rel] = countTopLevelDeclarations(join(SERVER_SRC, rel));
    }

    const { over, stale } = compareRatchet(BASELINE, current);

    expect(
      over,
      `A #728 candidate grew. Split it, or raise the baseline deliberately and say why:\n${over.join("\n")}`,
    ).toEqual([]);
    expect(
      stale,
      `A baseline is above the real count — lower it so it stays a ratchet, not a budget:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});
