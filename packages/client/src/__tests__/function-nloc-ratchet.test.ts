// @gate:always-run — walks the client src tree with the TS compiler; imports nothing it measures.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { FUNCTION_NLOC_BASELINE, SHRINK_GRACE, LIST_THRESHOLD } from "./function-nloc-baseline.js";

/**
 * #763 — long functions are a SHRINK-ONLY ring, and the shape of that ring is the whole
 * point of the ticket.
 *
 * The measurement #763 reports is DMM size = 0.483: of every line that landed in a unit in
 * the last 90 days, 48.3% went into a unit that was already <= 15 nloc, and 51.7% into one
 * that was not. The ticket is explicit that a repo-wide "max function length" gate is the
 * WRONG remedy — at 0.483 roughly half of all change already lands on the wrong side, so a
 * hard ceiling would block ordinary work on day one. A shrink-only ratchet on a named list is
 * the shape that fits (#705/#721 are the precedents).
 *
 * ── What was re-derived, and what it changed ────────────────────────────────────────────
 *
 * The ticket's "where it is happening" list is NOT the list this baseline uses, because six
 * of its eight entries do not survive measurement. Measured with the scanner below, at HEAD
 * and again at `931ef537ff` — the exact code sha the ticket cites, so this is not tree drift:
 *
 *   ticket                                        claimed nloc   measured @931ef537ff   @HEAD
 *   SettingsPanel.tsx::handleSave                          256                     40      24
 *   Layout.tsx::handleAddRepoSubmit                        331                     26      26
 *   CreateIssuePanel.tsx::(anonymous)                      228                     19      19
 *   WorkspacePanel.tsx::fetchWorkspaces                    198                     24      24
 *   StrategyTargetsView.tsx::updateProviderPolicy          197                      8       8
 *   CreateIssueForm.tsx::handleBlur                        181                      5       5
 *   IssueDetailPanel.tsx::IssueDetailPanel                 240                    561     561
 *   TableView.tsx::TableView                               165                    416     416
 *
 * Six handlers are 5-26 nloc — at or near the 15-line threshold, not 10-20x over it. The two
 * that ARE large are whole React components, and there the claimed number is far BELOW the
 * extent. The claimed column is not a measurement of the named function's extent in either
 * direction, so baselining it would have frozen six already-small functions and produced a
 * gate that is red on arrival at any number we chose.
 *
 * ── The interpretation does not survive either ──────────────────────────────────────────
 *
 * The ticket reads 0.483 as "the team is writing long functions, and then adding to them".
 * Statically, this codebase is already made of long units: of all lines inside a unit,
 * 92% (client), 80% (server) and 66% (shared) sit in units over 15 nloc. If change landed in
 * proportion to the code's shape, DMM size would be ~0.08-0.20. At 0.483 change is landing in
 * SHORT units at roughly 2.4-6x the rate the existing code would predict — the opposite of
 * the stated reading. What 0.483 mostly reflects is that a 15-nloc threshold classifies this
 * repo's ordinary architectural units as oversized: every one of the 23 largest functions is
 * a React component, a route or a `createXService` factory.
 *
 * So this gate enforces the property that IS worth enforcing and is independent of the
 * threshold argument: the functions that are genuinely unreadable may not get worse, and no
 * new one may join them unnoticed.
 *
 * ── Why AST, not a brace match ──────────────────────────────────────────────────────────
 *
 * `sliceTopLevelFunction` (the shared guard helper) relies on a closing brace at column 0.
 * Every function here is a component or a handler nested inside one, so its braces are
 * indented; a regex would get the extent wrong SILENTLY, which is the one failure mode a size
 * ratchet must not have.
 *
 * PROOF THIS GATE IS NOT VACUOUS: see the last describe block, which runs the same comparison
 * against synthetic measurements for growth, shrink, disappearance and a new unlisted
 * offender, and asserts each is reported.
 */
const CLIENT_SRC = path.join(import.meta.dirname!, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["__tests__", "node_modules", "dist"].includes(e.name)) out.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.") && !e.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * The name a function is FOUND BY: its own for a declaration or method, otherwise the
 * `const`/property it is assigned to — which is how every handler in these files is written.
 */
function nameOf(node: ts.Node): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.getText();
  if (parent && ts.isPropertyAssignment(parent) && parent.name) return parent.name.getText();
  return "(anonymous)";
}

/**
 * Lines in `[startLine, endLine]` that are neither blank nor comment-only.
 *
 * This is the definition the baseline was measured under, so the comparison is self
 * consistent; it is deliberately not an attempt to reproduce any particular tool's counter.
 */
function countNloc(source: string, startLine: number, endLine: number): number {
  const lines = source.split(/\r?\n/).slice(startLine, endLine + 1);
  let n = 0;
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      const close = line.indexOf("*/");
      if (close < 0) continue;
      inBlock = false;
      if (!line.slice(close + 2).trim()) continue;
      n++;
      continue;
    }
    if (!line) continue;
    if (line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      if (!line.replace(/\/\*[\s\S]*?\*\//g, "").trim()) continue;
    }
    n++;
  }
  return n;
}

/**
 * `path::name` -> nloc, for every OUTERMOST function in the client tree.
 *
 * Outermost only: counting a component AND each handler inside it would double-count the same
 * lines, and would let a component be "shrunk" by hoisting a handler that still sits in the
 * same file.
 */
function measureClient(): Record<string, number> {
  const measured: Record<string, number> = {};
  for (const file of sourceFiles(CLIENT_SRC)) {
    const source = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rel = path.relative(CLIENT_SRC, file).replaceAll("\\", "/");
    const visit = (node: ts.Node, inside: boolean): void => {
      let nowInside = inside;
      if (isFunctionLike(node) && !inside) {
        const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
        const key = `${rel}::${nameOf(node)}`;
        const nloc = countNloc(source, startLine, endLine);
        // Same key twice in one file (several `(anonymous)`): keep the largest, so a second
        // tiny declaration cannot make the measurement drop and read as progress.
        measured[key] = Math.max(measured[key] ?? 0, nloc);
        nowInside = true;
      }
      ts.forEachChild(node, (child) => visit(child, nowInside));
    };
    ts.forEachChild(sf, (child) => visit(child, false));
  }
  return measured;
}

interface Verdict {
  grew: string[];
  vanished: string[];
  stale: string[];
  unlisted: string[];
}

/**
 * The four ways this ring can be violated. Separated from the measurement so the last
 * describe block can drive it with synthetic input and prove each one actually reports.
 */
export function compareNlocRatchet(
  baseline: Readonly<Record<string, number>>,
  measured: Readonly<Record<string, number>>,
  grace: readonly string[],
  threshold: number,
): Verdict {
  const grew: string[] = [];
  const vanished: string[] = [];
  const stale: string[] = [];
  const unlisted: string[] = [];
  for (const [key, allowed] of Object.entries(baseline)) {
    const found = measured[key];
    if (found === undefined) {
      vanished.push(`${key}: no longer declared — delete this baseline entry`);
      continue;
    }
    if (found > allowed) grew.push(`${key}: ${found} > baseline ${allowed}`);
    else if (found < allowed && !grace.includes(key)) stale.push(`${key}: ${found} < baseline ${allowed} — lower it to ${found}`);
  }
  for (const [key, found] of Object.entries(measured)) {
    if (found >= threshold && !(key in baseline)) unlisted.push(`${key}: ${found} (NEW offender — not in the baseline)`);
  }
  return { grew, vanished, stale, unlisted };
}

describe("client function nloc is a shrink-only ring (#763)", () => {
  const measured = measureClient();
  const verdict = compareNlocRatchet(FUNCTION_NLOC_BASELINE, measured, SHRINK_GRACE, LIST_THRESHOLD);

  it("the scanner finds the functions it claims to — a broken extent would silently pass everything", () => {
    // Guards the measurement itself. If the AST walk or the nloc counter regressed, every
    // other assertion here would go quietly green on numbers that mean nothing.
    expect(Object.keys(measured).length).toBeGreaterThan(500);
    expect(measured["components/TableView.tsx::TableView"]).toBeGreaterThan(300);
    expect(measured["components/ButlerView.tsx::ButlerView"]).toBeGreaterThan(300);
    // A small handler must measure small — the failure mode that made #763's own list wrong
    // was a per-function number that did not describe the function's extent.
    expect(measured["components/StrategyTargetsView.tsx::StrategyTargetsView"]).toBeGreaterThan(300);
  });

  it("no listed function has grown", () => {
    expect(verdict.grew).toEqual([]);
  });

  it("no baseline entry is stale (a shrink must be banked, not left as budget)", () => {
    expect(verdict.stale).toEqual([]);
  });

  it("no baseline entry names a function that no longer exists", () => {
    expect(verdict.vanished).toEqual([]);
  });

  it(`no unlisted function is at or above ${LIST_THRESHOLD} nloc`, () => {
    expect(verdict.unlisted).toEqual([]);
  });

  it("every SHRINK_GRACE entry is a real baseline entry", () => {
    // A grace entry that has drifted off the baseline excuses nothing and hides the fact that
    // the temporary waiver was never cleaned up.
    const ghosts = SHRINK_GRACE.filter((k) => !(k in FUNCTION_NLOC_BASELINE));
    expect(ghosts).toEqual([]);
  });
});

describe("compareNlocRatchet reports each violation (the proof this gate can fail)", () => {
  const baseline = { "a.tsx::A": 100, "b.tsx::B": 50 };

  it("reports GROWTH", () => {
    const v = compareNlocRatchet(baseline, { "a.tsx::A": 101, "b.tsx::B": 50 }, [], 400);
    expect(v.grew).toEqual(["a.tsx::A: 101 > baseline 100"]);
    expect(v.stale).toEqual([]);
  });

  it("reports a STALE entry, so a shrink tightens the baseline instead of becoming budget", () => {
    const v = compareNlocRatchet(baseline, { "a.tsx::A": 80, "b.tsx::B": 50 }, [], 400);
    expect(v.stale).toEqual(["a.tsx::A: 80 < baseline 100 — lower it to 80"]);
  });

  it("waives ONLY the stale half for a graced entry, and still catches its growth", () => {
    expect(compareNlocRatchet(baseline, { "a.tsx::A": 80, "b.tsx::B": 50 }, ["a.tsx::A"], 400).stale).toEqual([]);
    expect(compareNlocRatchet(baseline, { "a.tsx::A": 101, "b.tsx::B": 50 }, ["a.tsx::A"], 400).grew).toHaveLength(1);
  });

  it("reports a VANISHED function (renamed or deleted) rather than reading it as a shrink to 0", () => {
    const v = compareNlocRatchet(baseline, { "b.tsx::B": 50 }, ["a.tsx::A"], 400);
    expect(v.vanished).toEqual(["a.tsx::A: no longer declared — delete this baseline entry"]);
    // Even a graced entry must not be allowed to disappear silently.
    expect(v.stale).toEqual([]);
  });

  it("reports a NEW unlisted offender at or above the threshold", () => {
    const v = compareNlocRatchet(baseline, { "a.tsx::A": 100, "b.tsx::B": 50, "c.tsx::C": 400 }, [], 400);
    expect(v.unlisted).toEqual(["c.tsx::C: 400 (NEW offender — not in the baseline)"]);
  });

  it("stays silent on a new function BELOW the threshold — the ticket forbids a repo-wide ceiling", () => {
    const v = compareNlocRatchet(baseline, { "a.tsx::A": 100, "b.tsx::B": 50, "c.tsx::C": 399 }, [], 400);
    expect(v).toEqual({ grew: [], vanished: [], stale: [], unlisted: [] });
  });
});
