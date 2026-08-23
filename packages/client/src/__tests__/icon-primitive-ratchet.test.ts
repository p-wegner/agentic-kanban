// @gate:always-run — walks the whole client source tree with the TS AST; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { compareRatchet, forEachNode, lineOf, parseGuardSource } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * Hand-written stroked `<svg>` is a DOWN-only ring (#810 part 1, follow-up to #772).
 *
 * ## What it guards
 *
 * The heroicons wrapper — `<svg xmlns=… className=… fill="none" viewBox="0 0 24 24"
 * stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round"
 * d=… /></svg>` — was hand-written at ~380 sites in this client. #772 measured
 * `WorkspacePanelHeader.tsx` at 58 % duplicated, re-measured it after its refactor, and found
 * it unmoved, because the file shares no BEHAVIOUR with anything: what it shares is that
 * wrapper, which is ~15 tokens long and therefore matches the duplication scanner's window
 * against roughly a hundred other components at once. That is the honest negative result #810
 * exists to fix, and it is not fixable by shaving lines in any one file — only by having the
 * wrapper exist once, in `components/Icon.tsx`.
 *
 * ## Why a ratchet and not a ban
 *
 * A hard "no raw `<svg>` in the client" rule would be wrong: charts legitimately compute their
 * own `viewBox`, size and geometry, and are not icons. So the rule this suite enforces is
 * narrower and mechanical — an `<svg>` that carries a `strokeWidth` anywhere inside it is
 * drawing a stroked GLYPH, which is exactly what `Icon` renders. Those are counted per file
 * and frozen. `strokeWidth` is the signal because it is the one attribute the wrapper cannot
 * do without and a chart axis has no reason to set.
 *
 * The remainder below is real and disclosed rather than implied away (CLAUDE.md #691): of the
 * 441 SVG elements in the client, 396 now go through the primitive and 45 do not — 40 of them
 * stroked, which is what this baseline holds, and 5 unstroked (filled marks) which this ring
 * does not claim to cover. 27 of the 40 are one file, `lib/viewRegistry.tsx`, blocked by a
 * layering rule and NOT by anything about icons; the other 13 are charts and bespoke
 * connectors that are not icons at all. Each is listed below with its reason. They may
 * SHRINK — converting one is a one-line baseline edit — and they may never grow.
 *
 * ## Where the counts come from
 *
 * The AST, not a regex: `strokeWidth` written across two lines by a formatter, or a `//` in a
 * class string, both defeat a line scan, and #779/#794 already established in this package
 * that a per-line regex is not evidence. NOTE `parseGuardSource` parses with
 * `setParentNodes: false`, so `node.parent` is ALWAYS `undefined` — a check that branches on
 * it silently passes everything. Nested `<svg>`s are therefore excluded via a PRE-PASS that
 * collects them into a `Set`, never by asking a node who its parent is.
 */

const clientSrc = path.join(import.meta.dirname!, "..");
const rel = (f: string) => path.relative(clientSrc, f).split(path.sep).join("/");

/**
 * The one file allowed to hand-write the wrapper: it IS the wrapper. Listed rather than
 * baselined at 2, so that "the primitive" and "a site that has not adopted it" never blur.
 */
const PRIMITIVE = "components/Icon.tsx";

/**
 * Raw stroked `<svg>` elements still in the tree, per file. **Only ever LOWER a number, and
 * delete the key when it reaches 0** — the `stale` half of `compareRatchet` fails the suite
 * if you do not, which is what keeps this a ratchet rather than a budget.
 *
 * Adding a NEW key fails too: reach for `<Icon d="…" />` (or `<Spinner />`), not a copy of the
 * wrapper. If a site genuinely cannot use the primitive, say why in a comment beside its entry.
 */
const RAW_STROKED_SVG: Record<string, number> = {
  // Sparklines and trend charts: the path `d` is computed from data, the `viewBox` from the
  // measured box, and the stroke is a series colour. These are DRAWINGS, not glyphs — `Icon`
  // has nothing to offer them, and forcing them through it would be worse than the count.
  "components/BurndownChart.tsx": 1,
  "components/InsightsPanel.tsx": 1,
  "components/LeadTimeTrendChart.tsx": 1,
  "components/MilestonesOverview.tsx": 1,
  "components/QualityMetricsView.tsx": 1,
  "components/WorkflowAnalyticsDashboard.tsx": 3,
  // Ring/donut gauges and a draggable radar: `<circle>` arcs whose stroke IS the datum
  // (dasharray progress, axis rings), sized in px rather than on the 24×24 icon grid.
  "components/BoardStats.tsx": 1,
  "components/MetricsView.tsx": 1,
  "components/StrategyBoard.tsx": 1,
  // The board-view icon table — 27 genuine heroicons glyphs, and the ONE entry here that is a
  // real remainder rather than "not an icon". It cannot import the primitive: `lib/` may not
  // import `components/`, and `client-upward-type-edge-ratchet.test.ts` (#694) is zero-tolerance
  // about that direction, type-only included. Adopting `Icon` here was tried and reverted for
  // exactly that reason. The fix is to move this JSX table DOWN into `components/` — it is
  // presentation, and it is the only `.tsx` in `lib/` that renders anything — which is a
  // separate change with its own importer churn, deliberately not folded into #810.
  "lib/viewRegistry.tsx": 27,
  // Tiny bespoke connector glyphs drawn on their own px grid (12×12, 24×16) with a 1.5 stroke,
  // one of them stroked with a computed edge colour. Convertible in principle — `Icon` takes a
  // `viewBox` and a `stroke` — but they are not heroicons paths and pretending otherwise would
  // make the primitive's contract vaguer than the two lines it would save.
  "components/CriticalPathSidePanel.tsx": 1,
  "components/EdgeEditPanel.tsx": 1,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function isJsx(node: ts.Node): node is JsxNode {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

/**
 * The tag name, read off the identifier rather than via `getText()` — `getText()` with no
 * argument calls `node.getSourceFile()`, which walks `.parent`, which is undefined here.
 */
function tagOf(node: JsxNode): string {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const tag = opening.tagName;
  return ts.isIdentifier(tag) ? tag.text : "";
}

function hasStrokeWidth(node: JsxNode): boolean {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.attributes.properties.some(
    (p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === "strokeWidth",
  );
}

/** Offenders per file: top-level `<svg>` elements with a `strokeWidth` on them or a descendant. */
function scan(): { counts: Record<string, number>; sites: string[] } {
  const counts: Record<string, number> = {};
  const sites: string[] = [];
  for (const file of walk(clientSrc)) {
    const sf = parseGuardSource(file);
    const svgs: JsxNode[] = [];
    // Pre-pass 1: every JSX element in the file, plus every `<svg>` among them.
    forEachNode(sf, (node) => {
      if (isJsx(node) && tagOf(node) === "svg") svgs.push(node);
    });
    // Pre-pass 2: the `<svg>`s that sit INSIDE another `<svg>`, collected into a Set. This is
    // the parent question asked the only way that works here — `node.parent` is undefined
    // under `setParentNodes: false`, so a `node.parent` check would exclude nothing and the
    // guard would double-count instead of failing loudly.
    const nested = new Set<ts.Node>();
    for (const outer of svgs) {
      forEachNode(outer, (inner) => {
        if (inner !== outer && isJsx(inner) && tagOf(inner) === "svg") nested.add(inner);
      });
    }
    for (const svg of svgs) {
      if (nested.has(svg)) continue;
      let stroked = hasStrokeWidth(svg);
      if (!stroked) forEachNode(svg, (n) => { if (isJsx(n) && hasStrokeWidth(n)) stroked = true; });
      if (!stroked) continue;
      const key = rel(file);
      counts[key] = (counts[key] ?? 0) + 1;
      sites.push(`${key}:${lineOf(sf, svg)}`);
    }
  }
  return { counts, sites };
}

/** Walking + parsing the whole client tree is I/O-bound; give it room under a loaded `test:mine`. */
const SCAN_TIMEOUT_MS = Number(process.env.VITEST_GUARD_SCAN_TIMEOUT) || 60_000;

describe("hand-written stroked <svg> is down-only (#810)", () => {
  const { counts, sites } = scan();

  it("the scan reaches the client tree and finds the primitive itself", () => {
    // Without this, a path typo or a rename makes every assertion below vacuously green —
    // the failure mode #772's own before/after measurement nearly walked into.
    expect(walk(clientSrc).length).toBeGreaterThan(200);
    expect(
      counts[PRIMITIVE],
      "components/Icon.tsx no longer hand-writes a stroked <svg> — either it moved, or the " +
        "scanner stopped matching the thing this whole ring is defined in terms of",
    ).toBeGreaterThan(0);
  }, SCAN_TIMEOUT_MS);

  it("no file hand-writes more stroked <svg> than its baseline, and none is new", () => {
    const measured = { ...counts };
    delete measured[PRIMITIVE];
    const { over } = compareRatchet(RAW_STROKED_SVG, measured);
    expect(
      over,
      "A stroked <svg> was hand-written instead of using the primitive. Use\n" +
        `  <Icon className="h-4 w-4" d="…" />   (or <Spinner /> for the busy arc)\n` +
        "from components/Icon.js — the wrapper is ~15 tokens long, which is exactly the window\n" +
        "the duplication scanner measures, so a copy of it inflates every icon-bearing file at\n" +
        "once. Sites found:\n" + sites.join("\n") + "\n\n" + over.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("no baseline entry is stale — the ring only ever shrinks", () => {
    // The half that makes this a ratchet rather than a budget (#691): once a file adopts the
    // primitive, its entry must come down, or the headroom becomes a licence to regress. A
    // key that reaches 0 is deleted, not left at 0.
    const measured = { ...counts };
    delete measured[PRIMITIVE];
    const { stale } = compareRatchet(RAW_STROKED_SVG, measured);
    expect(
      stale,
      "lower (or delete) these RAW_STROKED_SVG entries — they are above what the tree holds:\n" +
        stale.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});

/**
 * The primitive is declared ONCE. A ratio ring cannot see a second `Icon` that has drifted
 * far enough from the first to fall under the duplication window — which is exactly how the
 * enhance logic survived #772 a third time inside `useIssueEditForm`.
 */
describe("the icon primitive is declared once (#810)", () => {
  it("Icon and Spinner each have exactly one declaring module", () => {
    const wrong: string[] = [];
    for (const symbol of ["Icon", "Spinner"]) {
      const decl = new RegExp(`^export function ${symbol}\\(`, "m");
      const declaring = walk(clientSrc).filter((f) => decl.test(fs.readFileSync(f, "utf8"))).map(rel);
      if (declaring.length !== 1 || declaring[0] !== PRIMITIVE) {
        wrong.push(`${symbol}: declared in [${declaring.join(", ")}], expected only ${PRIMITIVE}`);
      }
    }
    expect(wrong, "import the primitive; do not copy it:\n" + wrong.join("\n")).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});
