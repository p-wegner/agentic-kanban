/**
 * Ceiling headroom (#1606) — for the files a ticket will likely touch, how close each one is
 * to the god-module gate's hard ceilings (`scripts/check-god-modules.mjs`): the line ceiling
 * and the per-function branch ceiling. A builder otherwise learns that the file it extends is
 * at 994/1000 lines, or that the function it grows is at 25/25 branches, only when the gate
 * refuses the merge.
 *
 * Best-effort and read-only: an unreadable file is skipped, and without the `typescript`
 * package the branch signal is skipped (it cannot be approximated by regex, same as the gate).
 * Keep the two constants in sync with the script.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CEILING_MAX_LINES = 1000;
export const CEILING_MAX_FUNCTION_BRANCHES = 25;
/** Only files within this many lines of the line ceiling are reported. */
export const LINE_HEADROOM_WINDOW = 50;
/** Only functions within this many branches of the branch ceiling are reported. */
export const BRANCH_HEADROOM_WINDOW = 3;

export interface CeilingHeadroom {
  file: string;
  lines: number | null;
  /** The worst function in the file, when it is within the branch window. */
  worstFunction: { name: string; branches: number } | null;
}

type TsModule = typeof import("typescript");

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Branch complexity of the worst function — mirrors `maxFunctionBranches` in the gate script. */
export function worstFunctionBranches(
  ts: TsModule,
  file: string,
  text: string,
): { name: string; branches: number } {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const isFn = (n: import("typescript").Node) =>
    ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) ||
    ts.isSetAccessor(n);
  const isBranch = (n: import("typescript").Node) =>
    ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isForStatement(n) ||
    ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) ||
    ts.isDoStatement(n) || ts.isCaseClause(n) || ts.isCatchClause(n);

  const queue: import("typescript").Node[] = [];
  const collectTop = (node: import("typescript").Node): void => {
    node.forEachChild((child) => {
      if (isFn(child)) queue.push(child);
      else collectTop(child);
    });
  };
  collectTop(sf);

  let worst = { name: "", branches: 0 };
  while (queue.length > 0) {
    const fn = queue.shift()!;
    let branches = 1;
    const walk = (node: import("typescript").Node): void => {
      node.forEachChild((child) => {
        if (isFn(child)) {
          queue.push(child);
          return;
        }
        if (isBranch(child)) branches++;
        walk(child);
      });
    };
    walk(fn);
    if (branches > worst.branches) {
      const named = (fn as { name?: import("typescript").Node }).name;
      worst = { name: named && ts.isIdentifier(named) ? named.text : "<anonymous>", branches };
    }
  }
  return worst;
}

async function loadTypescript(): Promise<TsModule | null> {
  try {
    const mod = await import("typescript");
    return (mod as unknown as { default?: TsModule }).default ?? (mod as unknown as TsModule);
  } catch {
    return null;
  }
}

/** Measure each file; entries are returned only for files near a ceiling. */
export async function measureCeilingHeadroom(
  repoPath: string,
  files: string[],
): Promise<CeilingHeadroom[]> {
  const candidates = files.filter((f) => /\.tsx?$/.test(f) && !/\.(test|spec)\.|\.d\.ts$|__tests__\//.test(f));
  if (candidates.length === 0) return [];
  const ts = await loadTypescript();
  const out: CeilingHeadroom[] = [];
  for (const file of candidates) {
    let text: string;
    try {
      text = await readFile(join(repoPath, file), "utf8");
    } catch {
      continue;
    }
    const lines = countLines(text);
    const nearLines = lines >= CEILING_MAX_LINES - LINE_HEADROOM_WINDOW && lines <= CEILING_MAX_LINES;
    let worstFunction: CeilingHeadroom["worstFunction"] = null;
    if (ts) {
      try {
        const worst = worstFunctionBranches(ts, file, text);
        if (
          worst.branches >= CEILING_MAX_FUNCTION_BRANCHES - BRANCH_HEADROOM_WINDOW &&
          worst.branches <= CEILING_MAX_FUNCTION_BRANCHES
        ) {
          worstFunction = worst;
        }
      } catch { /* best-effort */ }
    }
    if (nearLines || worstFunction) out.push({ file, lines: nearLines ? lines : null, worstFunction });
  }
  return out;
}

/** Pull repo-relative source paths a ticket names in its text. */
export function extractNamedPaths(text: string): string[] {
  const found = text.match(/[\w@./-]+\/[\w.-]+\.(?:tsx?|mjs|cjs|js)\b/g) ?? [];
  return [...new Set(found.map((p) => p.replace(/^\.\//, "")))];
}

/** Render the primer subsection, or null when nothing is near a ceiling. */
export function formatCeilingHeadroom(entries: CeilingHeadroom[]): string | null {
  if (entries.length === 0) return null;
  const rows = entries.map((e) => {
    const base = e.file.split("/").pop() ?? e.file;
    const parts: string[] = [];
    if (e.lines != null) parts.push(`${e.lines}/${CEILING_MAX_LINES} lines`);
    if (e.worstFunction) {
      parts.push(`${e.worstFunction.name}() ${e.worstFunction.branches}/${CEILING_MAX_FUNCTION_BRANCHES} branches`);
    }
    return `- \`${base}\` (${e.file}) ${parts.join("; ")} -> extend in a new module`;
  });
  return [
    "### Ceiling Headroom\n",
    "These files are near the god-module gate's ceilings; adding to them will fail the gate.\n",
    ...rows,
    "",
  ].join("\n");
}
