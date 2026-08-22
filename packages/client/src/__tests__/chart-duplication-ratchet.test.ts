// @gate:always-run — recursively walks the client component tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The dashboard charts' duplication is a DOWN-only ring (#732).
 *
 * #732 reported 37 production files at >= 50 % duplicated code, the chart components at the
 * top of the list. Re-measured in this tree with the token-windowed method below, the four
 * windowed charts scored:
 *
 * | file | before | after |
 * |---|---|---|
 * | `ProviderMixChart.tsx`          | 78 % (220 SLOC) | off the list (32 SLOC) |
 * | `ProviderCostOverTimeChart.tsx` | 72 % (229 SLOC) | off the list (33 SLOC) |
 * | `ThroughputChart.tsx`           | 67 % (173 SLOC) | off the list (73 SLOC) |
 * | `ScorecardDistributionChart.tsx`| 52 % (190 SLOC) | off the list (82 SLOC) |
 *
 * This is the ratchet that keeps them there, and it is the reason the win is not a "batch 1
 * of N" promise with nowhere to land (see CLAUDE.md, #691): the numbers below may only
 * SHRINK. A fifth chart pasted from a fourth, or a shared primitive quietly re-inlined,
 * fails here — which a one-off refactor commit cannot do.
 *
 * WHY A LOCAL SCANNER and not a metrics tool: the measure has to be reproducible from the
 * repo alone, with no external analyzer and no cached report, or the baseline below cannot
 * be re-derived by whoever it fails on. It is deliberately a heuristic net — an exact
 * 15-token window over comment-stripped, string-normalised source — not a proof. Type-2
 * clones (same shape, renamed identifiers) are invisible to it. That is accepted: the job
 * is to stop the measured duplication regrowing, not to certify its absence.
 */

/** Files the ring covers: the chart family and the modules extracted out of it. */
const SCOPE = [
  "components/ChartFrame.tsx",
  "components/ChartPrimitives.tsx",
  "components/ProviderCostOverTimeChart.tsx",
  "components/ProviderMixChart.tsx",
  "components/ProviderStackedChart.tsx",
  "components/ScorecardDistributionChart.tsx",
  "components/ThroughputChart.tsx",
  "hooks/useWindowedChartData.ts",
  "lib/chartGeometry.ts",
];

/**
 * Highest tolerated share of a file's 15-token windows that also occur in ANOTHER file in
 * the client tree, as a percentage. Only ever LOWER a number — a raised one is the
 * regression this suite exists to catch.
 *
 * All nine sit far below the 50 % threshold #732 used. The caps are set a few points above
 * the measured value so an unrelated edit elsewhere in the client (which can make a window
 * newly shared) does not fail the gate spuriously.
 */
const MAX_DUP_PERCENT: Record<string, number> = {
  "components/ChartFrame.tsx": 30,          // measured 23
  "components/ChartPrimitives.tsx": 24,     // measured 15
  "components/ProviderCostOverTimeChart.tsx": 25, // measured 16
  "components/ProviderMixChart.tsx": 24,    // measured 15
  "components/ProviderStackedChart.tsx": 16, // measured 7
  "components/ScorecardDistributionChart.tsx": 44, // measured 36
  "components/ThroughputChart.tsx": 47,     // measured 39
  "hooks/useWindowedChartData.ts": 12,      // measured 3
  "lib/chartGeometry.ts": 12,               // measured 3
};

/** Window length in tokens. 15 reproduced #732's published per-file ratios most closely. */
const WINDOW = 15;

const clientSrc = path.join(import.meta.dirname!, "..");
const rel = (f: string) => path.relative(clientSrc, f).split(path.sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Drop comment bodies so prose about the duplication does not count as duplication. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const TOKEN =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|\S/g;

/**
 * Tokenise, collapsing every string literal to one `STR` token.
 *
 * Load-bearing: without it two components that share a 40-line Tailwind class string count
 * as duplicated only when the string is character-identical, and a single changed colour
 * would read as "duplication removed". Normalising makes the measure about STRUCTURE.
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const src = stripComments(text);
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(src))) out.push(/^["'`]/.test(m[0]) ? "STR" : m[0]);
  return out;
}

function windowHashes(tokens: string[]): string[] {
  const hashes: string[] = [];
  for (let i = 0; i + WINDOW <= tokens.length; i++) {
    hashes.push(crypto.createHash("sha1").update(tokens.slice(i, i + WINDOW).join(" ")).digest("hex").slice(0, 16));
  }
  return hashes;
}

/** Percentage of each file's windows that also occur in some OTHER client file. */
function duplicationPercentByFile(): Record<string, number> {
  const files = walk(clientSrc);
  const hashesByFile = new Map<string, string[]>();
  const owners = new Map<string, Set<string>>();
  for (const file of files) {
    const hashes = windowHashes(tokenize(fs.readFileSync(file, "utf8")));
    const key = rel(file);
    hashesByFile.set(key, hashes);
    for (const h of new Set(hashes)) {
      let set = owners.get(h);
      if (!set) owners.set(h, (set = new Set()));
      set.add(key);
    }
  }
  const out: Record<string, number> = {};
  for (const [key, hashes] of hashesByFile) {
    if (hashes.length === 0) {
      out[key] = 0;
      continue;
    }
    let shared = 0;
    for (const h of hashes) {
      const set = owners.get(h)!;
      if (set.size > 1) shared++;
    }
    out[key] = Math.round((shared / hashes.length) * 100);
  }
  return out;
}

/** Scanning the whole client tree is I/O-bound; give it room under a loaded `test:mine`. */
const SCAN_TIMEOUT_MS = Number(process.env.VITEST_GUARD_SCAN_TIMEOUT) || 60_000;

describe("chart duplication is down-only (#732)", () => {
  const dup = duplicationPercentByFile();

  it("the scan reaches the client tree and every scoped file", () => {
    // A path typo or a rename would otherwise make every assertion below vacuously green.
    expect(Object.keys(dup).length).toBeGreaterThan(200);
    const missing = SCOPE.filter((f) => !(f in dup));
    expect(missing, `scoped file not found — rename it here too:\n${missing.join("\n")}`).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("no chart module exceeds its duplication cap", () => {
    const over = SCOPE.filter((f) => dup[f] > MAX_DUP_PERCENT[f]).map(
      (f) => `${f}: ${dup[f]}% > cap ${MAX_DUP_PERCENT[f]}%`,
    );
    expect(
      over,
      "Duplication regrew in the chart family. Extract the shared shape into ChartFrame /\n" +
        "ChartPrimitives / lib/chartGeometry.ts (or ProviderStackedChart for a stacked-by-\n" +
        "provider chart) instead of copying a sibling chart:\n" +
        over.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("no cap is stale — the ring only ever shrinks", () => {
    // The half that makes this a ratchet rather than a threshold: once a file improves, the
    // cap must follow it down, or the headroom silently becomes a licence to regress.
    const slack = SCOPE.filter((f) => MAX_DUP_PERCENT[f] - dup[f] > 12).map(
      (f) => `${f}: cap ${MAX_DUP_PERCENT[f]}%, actual ${dup[f]}% — lower the cap`,
    );
    expect(slack, slack.join("\n")).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("every scoped file is well under the 50% threshold #732 measured", () => {
    const offenders = SCOPE.filter((f) => dup[f] >= 50).map((f) => `${f}: ${dup[f]}%`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});

/**
 * The other half of "genuinely gone, not merely relocated": each extracted piece must exist
 * in exactly ONE module. A ratio cap alone cannot see a second copy that has drifted enough
 * to fall under the window threshold.
 */
describe("the chart shell is declared once (#732)", () => {
  const declarations: Record<string, string> = {
    // The window-selector button row, the loading row, the error+Retry block, the empty card.
    "ChartFrame": "components/ChartFrame.tsx",
    "ChartStatTile": "components/ChartFrame.tsx",
    "ChartAxes": "components/ChartPrimitives.tsx",
    "ChartLegend": "components/ChartPrimitives.tsx",
    "StackedBars": "components/ChartPrimitives.tsx",
    "SimpleBars": "components/ChartPrimitives.tsx",
    "summarizeStacks": "lib/chartGeometry.ts",
    "chartBox": "lib/chartGeometry.ts",
    "fmtChartDate": "lib/chartGeometry.ts",
    "fmtUsd": "lib/chartGeometry.ts",
    "providerColor": "lib/chartColors.ts",
    "useWindowedChartData": "hooks/useWindowedChartData.ts",
  };

  it("each shared chart symbol has exactly one declaring module", () => {
    const files = walk(clientSrc);
    const wrong: string[] = [];
    for (const [symbol, home] of Object.entries(declarations)) {
      const decl = new RegExp(`^export (?:function|const|interface) ${symbol}\\b`, "m");
      const declaring = files.filter((f) => decl.test(fs.readFileSync(f, "utf8"))).map(rel);
      if (declaring.length !== 1 || declaring[0] !== home) {
        wrong.push(`${symbol}: declared in [${declaring.join(", ")}], expected only ${home}`);
      }
    }
    expect(
      wrong,
      "A shared chart piece was re-declared or moved. Import it; do not copy it:\n" + wrong.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("the window-selector class string is a shrink-only ring", () => {
    // The single most-copied fragment in the chart family before #732: the selected /
    // unselected button classes, spelled out in all four windowed charts.
    //
    // Five OTHER analytics components hold the same string and are out of #732's scope —
    // they are not in the >= 50 %-duplicated set this ticket addresses, and migrating them
    // is follow-up work, not this commit's. Grandfathered as a list rather than a count so
    // a NEW holder is named at the point it appears; the list may only shrink.
    const GRANDFATHERED = [
      "components/AgentThroughputLeaderboard.tsx",
      "components/BurndownChart.tsx",
      "components/LeadTimeTrendChart.tsx",
      "components/MilestonesOverview.tsx",
      "components/WorkflowAnalyticsDashboard.tsx",
    ];
    const marker = "bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900";
    const holders = walk(clientSrc)
      .filter((f) => fs.readFileSync(f, "utf8").includes(marker))
      .map(rel)
      .sort();

    const unexpected = holders.filter((f) => f !== "components/ChartFrame.tsx" && !GRANDFATHERED.includes(f));
    expect(
      unexpected,
      "the window selector lives in ChartFrame; pass `windows`/`days`/`onDaysChange` " +
        "instead of copying its class strings:\n" + unexpected.join("\n"),
    ).toEqual([]);

    // The ring only shrinks: a migrated component must be deleted from the list above.
    const stale = GRANDFATHERED.filter((f) => !holders.includes(f));
    expect(stale, "migrated — delete from GRANDFATHERED:\n" + stale.join("\n")).toEqual([]);

    // And none of #732's own charts may reappear.
    const regressed = holders.filter((f) => SCOPE.includes(f) && f !== "components/ChartFrame.tsx");
    expect(regressed, regressed.join("\n")).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});
