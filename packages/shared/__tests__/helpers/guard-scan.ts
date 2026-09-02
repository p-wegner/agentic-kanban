/**
 * Shared machinery for the repo's GUARD SUITES (#583).
 *
 * A guard suite asserts a property of the whole repo tree rather than of a module: no raw
 * `git` spawn outside the adapter, no untagged `console.*`, one declaration per wire DTO, a
 * `@gate:always-run` marker on every import-graph-invisible suite. Because their subject is
 * the TREE, they all begin the same way — walk a package's sources, skipping `__tests__`,
 * `node_modules`, `dist` and `.test.` files — and that walker was copy-pasted into ≥8 suites,
 * character for character in places, along with the counted-ratchet comparison that follows it.
 *
 * Copy-paste in a guard is not a style problem: each copy is a place the SCAN can silently
 * diverge from what the guard claims to cover. `countAlwaysRunGuardSuites` drifted exactly
 * that way — its private flat `readdirSync` never saw `mcp-server/src/__tests__/tools/` (33
 * suites), so the gate under-reported for months while the marker ratchet, which had been
 * fixed to recurse, was green.
 *
 * Import from a test in any package via its relative path — these are test-only helpers and
 * are deliberately NOT exported from the `shared` package barrel.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SKIP_DIRS = new Set(["__tests__", "node_modules", "dist", "coverage", ".git"]);

export interface WalkOptions {
  /** File extensions to collect, WITH the dot. Default: `.ts` and `.tsx`. */
  extensions?: string[];
  /** Directory names to skip anywhere in the tree. Default: {@link SKIP_DIRS}. */
  skipDirs?: Set<string>;
  /** Include `*.test.*` files. Default false — a guard scans PRODUCTION sources. */
  includeTests?: boolean;
}

/**
 * Every source file under `absDir`, recursively. Returns `[]` for a missing directory rather
 * than throwing, because a guard that scans several roots must not die on the one a given
 * checkout happens not to have.
 */
export function walkPackageSources(absDir: string, options: WalkOptions = {}): string[] {
  const extensions = options.extensions ?? [".ts", ".tsx"];
  const skipDirs = options.skipDirs ?? SKIP_DIRS;
  const includeTests = options.includeTests ?? false;
  if (!fs.existsSync(absDir)) return [];

  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name) && !entry.name.startsWith(".")) walk(full);
        continue;
      }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      // A generated declaration is never what a guard means by "a source file".
      if (entry.name.endsWith(".d.ts")) continue;
      if (!includeTests && entry.name.includes(".test.")) continue;
      out.push(full);
    }
  };
  walk(absDir);
  return out;
}

/** Every `*.test.*` file under a `__tests__` tree, recursively. */
export function walkTestFiles(absDir: string): string[] {
  return walkPackageSources(absDir, {
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    includeTests: true,
    skipDirs: new Set(["node_modules", "dist", "coverage", ".git"]),
  }).filter((f) => /\.test\.[a-z]+$/.test(path.basename(f)));
}

/** The monorepo's `packages/` directory, resolved from a suite's own module directory. */
export function packagesRootFrom(testModuleDir: string, upLevels: number): string {
  return path.resolve(testModuleDir, ...Array.from({ length: upLevels }, () => ".."));
}

export interface RatchetVerdict {
  /** Entries whose count EXCEEDS the baseline — the regressions that must fail the suite. */
  over: string[];
  /** Entries whose count is now BELOW the baseline — the baseline is stale and should drop. */
  stale: string[];
}

/**
 * Compare measured counts against a frozen baseline, both directions.
 *
 * The one-directional half is what every counted ratchet in this repo already does. The other
 * half is the one people forget and the reason the discipline works at all: a baseline nobody
 * ever LOWERS stops being a ceiling and becomes a budget, and the next regression hides inside
 * the slack that an earlier cleanup opened up. Reporting `stale` makes shrinking mandatory
 * rather than polite.
 *
 * A key absent from `current` counts as 0, so deleting the last offender for a key surfaces as
 * stale (drop the key) rather than passing silently.
 */
export function compareRatchet(
  baseline: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
): RatchetVerdict {
  const over: string[] = [];
  const stale: string[] = [];
  for (const [key, allowed] of Object.entries(baseline)) {
    const found = current[key] ?? 0;
    if (found > allowed) over.push(`${key}: ${found} > baseline ${allowed}`);
    else if (found < allowed) stale.push(`${key}: ${found} < baseline ${allowed} — lower it`);
  }
  for (const [key, found] of Object.entries(current)) {
    if (found > 0 && !(key in baseline)) over.push(`${key}: ${found} (NEW — not in the baseline)`);
  }
  return { over, stale };
}

/**
 * The source text of a top-level `export function <name>(…) { … }`, from the `export` keyword
 * to its closing brace, or `null` if the file declares no such function.
 *
 * Guards about PURITY have to work at function granularity, not file granularity: a service
 * module routinely holds one pure `resolveX(prefMap, …)` beside db-reading functions, so
 * "this file imports `repositories/`" says nothing about whether the resolver is pure. The
 * brace match relies on the repo's formatting (a top-level declaration's closing brace sits at
 * column 0), which is what Prettier guarantees here — good enough for a guard, and it returns
 * null rather than guessing when the shape is unfamiliar.
 */
export function sliceTopLevelFunction(source: string, name: string): string | null {
  const start = source.search(new RegExp(`^export (?:async )?function ${name}\\b`, "m"));
  if (start < 0) return null;
  const end = source.indexOf("\n}", start);
  return end < 0 ? null : source.slice(start, end + 2);
}

/** Every binding a file imports from a module specifier matching `modulePattern`. */
export function importedBindingsFrom(source: string, modulePattern: RegExp): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
    if (m[1] || !modulePattern.test(m[3])) continue;
    for (const raw of m[2].split(",")) {
      const binding = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (binding) names.push(binding);
    }
  }
  for (const m of source.matchAll(/import\s+(\w+)\s+from\s+"([^"]+)"/g)) {
    if (modulePattern.test(m[2])) names.push(m[1]);
  }
  return names;
}

/* ------------------------------------------------------------------------- *
 * The TYPED layer (#721)
 *
 * Every guard in this repo used to be a regex over source TEXT, and #721's
 * fault-injection round showed what that costs: the semantically identical
 * variant always escapes. `res.code === 0` was caught; `res.code > 0`,
 * `!res.code` and `const { code } = res` were not. A guard that scans text can
 * only ever assert one SPELLING of its invariant.
 *
 * These helpers give a guard the TypeScript AST instead, cheaply:
 *
 *   - `parseGuardSource` parses with `setParentNodes: false`. That flag is not a
 *     detail — measured over this repo's 1410 source files, `true` costs 49 s and
 *     `false` costs 0.7 s. A `@gate:always-run` suite runs on every merge, so the
 *     fast path is the only affordable one, and the price is that `node.parent`
 *     is undefined: use {@link forEachNode}, which hands the parent down.
 *   - Parses are memoised per absolute path for the lifetime of the worker, so
 *     several guard suites in one vitest process parse the tree once between them.
 * ------------------------------------------------------------------------- */

const parseCache = new Map<string, ts.SourceFile>();
const textCache = new Map<string, string>();

/**
 * The source text of one file, memoised per absolute path (#994).
 *
 * A guard suite typically walks the same tree once per `it`, and each walk re-reads every
 * file. That is invisible on a warm page cache (~1 s here) and dominant on a cold one: the
 * god-module suite measured 4 s warm against 158 s cold, past the 120 s vitest timeout — and
 * a timed-out guard reports as a FAILURE, i.e. as "a source file breached the god-module
 * ceiling" when nothing breached. Reading each file once per worker is what takes the cold
 * cost off the multiplier.
 */
export function readGuardSource(absFile: string): string {
  const cached = textCache.get(absFile);
  if (cached !== undefined) return cached;
  const text = fs.readFileSync(absFile, "utf8");
  textCache.set(absFile, text);
  return text;
}

/** The parsed AST of one source file, memoised. Comments are not nodes, so a guard walking this tree never needs to strip them. */
export function parseGuardSource(absFile: string, text?: string): ts.SourceFile {
  const cached = parseCache.get(absFile);
  if (cached) return cached;
  const source = text ?? readGuardSource(absFile);
  const sf = ts.createSourceFile(
    absFile,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    absFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  parseCache.set(absFile, sf);
  return sf;
}

/**
 * Every node under `root`, depth-first, with its parent — the parent that
 * `setParentNodes: false` does not store on the node itself.
 */
export function forEachNode(root: ts.Node, visit: (node: ts.Node, parent: ts.Node | undefined) => void): void {
  const walk = (node: ts.Node, parent: ts.Node | undefined): void => {
    visit(node, parent);
    node.forEachChild((child) => walk(child, node));
  };
  walk(root, undefined);
}

/** The 1-based line of a node, for an offender message a human can jump to. */
export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Strip `await`, parentheses and `as`/`!` assertions to get at the expression that actually produces a value. */
export function unwrapExpression(expr: ts.Expression): ts.Expression {
  let cur = expr;
  for (;;) {
    if (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

/** The callee's simple name for `f(...)`, `a.f(...)` or `a?.f(...)`; `null` for anything more exotic. */
export function calleeName(call: ts.CallExpression): string | null {
  const target = unwrapExpression(call.expression);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return null;
}

/**
 * The text of the full-line comments that sit immediately ABOVE a node, or `""` when the
 * line above it is code (#794).
 *
 * Several guards grant a per-call opt-out through a comment on the preceding line — an
 * `eslint-disable-next-line no-restricted-syntax -- <reason>`, a `SELF-HTTP OK: <why>`. A
 * comment is not an AST node, so an AST guard cannot see one by walking the tree, and
 * `ts.getLeadingCommentRanges` answers for the node it is asked about — which for
 * `const r = await fetch(u)` is the STATEMENT, not the call this guard matched. Scanning
 * backwards from the start of the node's own LINE answers the question the guards actually
 * ask ("is the opt-out written directly above this call?") at any nesting depth, without
 * needing parent pointers that {@link parseGuardSource} deliberately does not store.
 *
 * Only comments that occupy a whole line count. A `//` inside a string on a code line is
 * not an opt-out, and the whitespace-only-prefix check is what tells the two apart — the
 * text-scanning versions of these guards could not, which is how a `//` inside a string
 * literal used to delete the rest of a line before the pattern ever ran.
 *
 * The two-line lookback these replaced was also wrong in the other direction: it excused
 * ANY call whose second-preceding line held the marker, so one exempted call granted its
 * unexempted NEIGHBOUR the same pass. Contiguity from the node's own line fixes that.
 */
export function leadingCommentText(sf: ts.SourceFile, node: ts.Node): string {
  const full = sf.getFullText();
  // Start at the beginning of the node's own line: the opt-out sits ABOVE the call, and the
  // call is usually preceded on its line by `const x = await `, which is not whitespace.
  let pos = full.lastIndexOf("\n", Math.max(0, node.getStart(sf) - 1)) + 1;
  const parts: string[] = [];
  for (;;) {
    let i = pos - 1;
    while (i >= 0 && /\s/.test(full[i]!)) i -= 1;
    if (i < 0) break;
    if (full[i] === "/" && i >= 1 && full[i - 1] === "*") {
      const start = full.lastIndexOf("/*", i - 1);
      if (start < 0) break;
      parts.unshift(full.slice(start, i + 1));
      pos = start;
      continue;
    }
    const lineStart = full.lastIndexOf("\n", i) + 1;
    const lineText = full.slice(lineStart, i + 1);
    const marker = lineText.indexOf("//");
    // Whitespace-only before the `//` — otherwise this is a trailing comment on a code line
    // (or a `//` inside a string), and neither is an opt-out written above the call.
    if (marker < 0 || lineText.slice(0, marker).trim() !== "") break;
    parts.unshift(full.slice(lineStart + marker, i + 1));
    pos = lineStart + marker;
  }
  return parts.join("\n");
}
