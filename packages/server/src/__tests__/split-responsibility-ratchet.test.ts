// @gate:always-run — reads source files it does not import; invisible to `vitest related`.
/**
 * The #728 split-responsibility remainder may only SHRINK.
 *
 * #728 lists 95 production files that carry a responsibility-split prescription — each one
 * a bridge between clusters AND internally heavy, and every one of them UNDER the 1000-line
 * god-module ceiling, so none is visible to `scripts/check-god-modules.mjs`. That
 * invisibility is the ticket's whole point, and it is also what makes a partial fix
 * dangerous: three files were split (see below), the other 92 were not, and nothing would
 * stop the split three from re-absorbing their halves or the named remainder from growing.
 *
 * This is that stop. It counts TOP-LEVEL DECLARATIONS — the load-bearing number, since the
 * ticket's subject is how many distinct things one module declares, not how long it is — for
 * the five files #728 named as its top candidates, and fails when one grows.
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
 * The three SPLIT files (#728 batch 1) are pinned at their post-split counts so the halves
 * cannot drift back in. The two UNSPLIT ones are pinned where the ticket found them — their
 * verdicts, and why they were left, are in the ticket and in `CONTINUE.md`.
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

  // --- named by #728, NOT split: the remainder this ratchet holds in place ---
  "services/devcontainer-workspace.service.ts": 22,
  "services/butler-definitions.service.ts": 21,
};

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
