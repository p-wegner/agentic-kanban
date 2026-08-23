/**
 * The function-nloc scanner and its ratchet comparison — ONE definition, shared by every
 * package's nloc ring (#763 client, #800 server).
 *
 * #763 wrote this inline in `packages/client/src/__tests__/function-nloc-ratchet.test.ts`
 * because the client tsconfig has no node types outside `*.test.ts`. #800 needed the same
 * measurement for the server tree, and a second copy of a MEASUREMENT is not a style problem:
 * two rings whose scanners drift apart no longer describe the same property, and neither
 * reader can tell which one moved. So it lives here, beside the other guard machinery, and is
 * imported by relative path from each package's test (these helpers are deliberately not
 * exported from the `shared` barrel).
 *
 * The definition, unchanged from #763:
 *   - OUTERMOST function-likes only (declaration, function expression, arrow, method).
 *     Counting a component AND each handler inside it would double-count the same lines, and
 *     would let a unit be "shrunk" by hoisting a handler that still sits in the same file.
 *   - nloc = lines in the declaration's extent that are neither blank nor comment-only.
 *   - The name a function is FOUND BY: its own for a declaration or method, otherwise the
 *     `const`/property it is assigned to.
 * It is deliberately not an attempt to reproduce any particular tool's counter; the baselines
 * are measured under it, so the comparison is self-consistent.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parseGuardSource, walkPackageSources } from "./guard-scan.js";

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** The name a function is FOUND BY. `parent` is passed in because the guard parser does not store it. */
function nameOf(node: ts.Node, parent: ts.Node | undefined, sf: ts.SourceFile): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText(sf);
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.getText(sf);
  if (parent && ts.isPropertyAssignment(parent) && parent.name) return parent.name.getText(sf);
  return "(anonymous)";
}

/**
 * Lines in `[startLine, endLine]` (0-based, inclusive) that are neither blank nor comment-only.
 */
export function countNloc(source: string, startLine: number, endLine: number): number {
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
 * `path::name` -> nloc, for every OUTERMOST function under `srcRoot`. Keys are POSIX-relative
 * to `srcRoot`, so a baseline is portable across checkouts and platforms.
 */
export function measureFunctionNloc(srcRoot: string): Record<string, number> {
  const measured: Record<string, number> = {};
  for (const file of walkPackageSources(srcRoot)) {
    const source = fs.readFileSync(file, "utf8");
    const sf = parseGuardSource(file, source);
    const rel = path.relative(srcRoot, file).replaceAll("\\", "/");
    const visit = (node: ts.Node, parent: ts.Node | undefined, inside: boolean): void => {
      let nowInside = inside;
      if (isFunctionLike(node) && !inside) {
        const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
        const key = `${rel}::${nameOf(node, parent, sf)}`;
        // Same key twice in one file (several `(anonymous)`): keep the largest, so a second
        // tiny declaration cannot make the measurement drop and read as progress.
        measured[key] = Math.max(measured[key] ?? 0, countNloc(source, startLine, endLine));
        nowInside = true;
      }
      ts.forEachChild(node, (child) => visit(child, node, nowInside));
    };
    ts.forEachChild(sf, (child) => visit(child, sf, false));
  }
  return measured;
}

export interface NlocVerdict {
  grew: string[];
  vanished: string[];
  stale: string[];
  unlisted: string[];
}

/**
 * The four ways an nloc ring can be violated. Separated from the measurement so a test can
 * drive it with synthetic input and prove each one actually reports.
 */
export function compareNlocRatchet(
  baseline: Readonly<Record<string, number>>,
  measured: Readonly<Record<string, number>>,
  grace: readonly string[],
  threshold: number,
): NlocVerdict {
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
