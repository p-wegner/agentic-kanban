// @gate:always-run — scans the packages tree for hand-rolled auto_merge reads; that half has no import edge (#647).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  AUTO_MERGE_DEFAULT_ENABLED,
  AUTO_MERGE_PREF_KEY,
  isAutoMergeEnabled,
} from "@agentic-kanban/shared/lib/auto-merge-pref";
import {
  parseGuardSource,
  forEachNode,
  lineOf,
  unwrapExpression,
  calleeName,
} from "../../../shared/__tests__/helpers/guard-scan.js";

describe("isAutoMergeEnabled — canonical auto_merge accessor (#866)", () => {
  it("defaults to ENABLED when the key is unset", () => {
    // Regression: the merge orchestrator used `!== "false"` (default ON) while the
    // monitor/Drive-UI/board-status used `=== "true"` (default OFF). With the key unset
    // they disagreed — behaviour said merge, the surfaced status said disabled. The
    // canonical default is ON.
    expect(AUTO_MERGE_DEFAULT_ENABLED).toBe(true);
    expect(isAutoMergeEnabled(new Map())).toBe(true);
  });

  it("is enabled for the explicit string 'true'", () => {
    expect(isAutoMergeEnabled(new Map([[AUTO_MERGE_PREF_KEY, "true"]]))).toBe(true);
  });

  it("is disabled ONLY for the explicit string 'false'", () => {
    expect(isAutoMergeEnabled(new Map([[AUTO_MERGE_PREF_KEY, "false"]]))).toBe(false);
  });

  it("treats any other non-empty value as enabled (default-ON semantics)", () => {
    expect(isAutoMergeEnabled(new Map([[AUTO_MERGE_PREF_KEY, ""]]))).toBe(true);
    expect(isAutoMergeEnabled(new Map([[AUTO_MERGE_PREF_KEY, "1"]]))).toBe(true);
  });
});

/**
 * Scan server + mcp-server src for raw `auto_merge` reads that hand-roll a default
 * (`=== "true"` / `!== "false"`) instead of going through isAutoMergeEnabled. The GLOBAL
 * key is `auto_merge`; per-project `auto_merge_disabled_<id>` and `auto_merge_in_review`
 * are different keys with their own intentional semantics, and an exact string-literal
 * match is what keeps them out.
 *
 * ## Why this is an AST pass and not a per-line regex (#794, following #779)
 *
 * The previous version tested `get("auto_merge") ===` against one LINE at a time, which is
 * the shape #779 proved is not evidence: `pref-polarity-ratchet` was green on a tree that
 * held exactly what it forbade, because the real read in `plugin-loop.service.ts` was
 * wrapped across two lines and neither line carried both halves. The same wrap evades this
 * guard, and nobody has to choose it — a formatter breaking a long comparison is enough.
 *
 * A `BinaryExpression` is one node however it is printed, so the wrap, an intervening
 * `await`, and added parentheses are all invisible to it. Two false-positive classes go
 * away for free, because comments and string literals are not expressions: prose about the
 * forbidden shape no longer counts as an instance of it.
 */
const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const scanRoots = [path.join(packagesRoot, "server", "src"), path.join(packagesRoot, "mcp-server", "src")];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** `"true"` / `"false"` written as a literal — the polarity half of the comparison. */
function isPolarityLiteral(expr: ts.Expression): boolean {
  const node = unwrapExpression(expr);
  return ts.isStringLiteralLike(node) && (node.text === "true" || node.text === "false");
}

/** True for `<anything>.get("auto_merge")` — the prefMap read, at any nesting or wrap. */
function readsAutoMergeKey(expr: ts.Expression): boolean {
  const node = unwrapExpression(expr);
  if (!ts.isCallExpression(node) || calleeName(node) !== "get") return false;
  const first = node.arguments[0];
  return !!first && ts.isStringLiteralLike(first) && first.text === AUTO_MERGE_PREF_KEY;
}

export interface AutoMergeHit {
  line: number;
  text: string;
}

/**
 * Every hand-rolled polarity read of the global `auto_merge` key in one source text.
 * Exported so the proof cases below drive the REAL scanner rather than a copy of its
 * predicate.
 */
export function scanAutoMergeSource(cacheKey: string, text: string): AutoMergeHit[] {
  const sf = parseGuardSource(cacheKey, text);
  const hits: AutoMergeHit[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isBinaryExpression(node)) return;
    const op = node.operatorToken.kind;
    if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return;
    const readSide = isPolarityLiteral(node.right) ? node.left : isPolarityLiteral(node.left) ? node.right : null;
    if (!readSide || !readsAutoMergeKey(readSide)) return;
    hits.push({ line: lineOf(sf, node), text: node.getText(sf).replace(/\s+/g, " ").slice(0, 160) });
  });
  return hits;
}

describe("no contradictory auto_merge defaults remain (#866)", () => {
  it("no server/mcp src reads the global auto_merge key with a hand-rolled default", () => {
    const offenders: string[] = [];
    for (const root of scanRoots) {
      for (const file of listTsFiles(root)) {
        const rel = path.relative(packagesRoot, file).replace(/\\/g, "/");
        for (const hit of scanAutoMergeSource(file, fs.readFileSync(file, "utf-8"))) {
          offenders.push(`${rel}:${hit.line}: ${hit.text}`);
        }
      }
    }
    expect(offenders, `Route these through isAutoMergeEnabled():\n${offenders.join("\n")}`).toEqual([]);
  });
});

/**
 * #779's proof obligation (#794): the conversion must catch the form the old per-line
 * version could not see, and still catch the one it did.
 */
describe("the auto_merge scan sees forms the per-line version could not (#794)", () => {
  const scan = (name: string, lines: string[]): AutoMergeHit[] =>
    scanAutoMergeSource(`/virtual/auto-merge/${name}.ts`, lines.join("\n"));

  it("still catches the one-line hand-rolled read the regex caught", () => {
    expect(scan("one-line", ['const on = prefMap.get("auto_merge") === "true";']).map((h) => h.line)).toEqual([1]);
  });

  it("catches the read WRAPPED across lines — the #779 evasion, verbatim", () => {
    // Neither line carries both halves, so the per-line regex saw nothing at all.
    const hits = scan("wrapped", ["const on =", '  prefMap.get("auto_merge")', '    !== "false";']);
    expect(hits.map((h) => h.line)).toEqual([2]);
  });

  it("catches it through an await and parentheses, with the literal on the LEFT", () => {
    const hits = scan("awaited", ['const on = "true" ===', "  (await prefs.get(", '    "auto_merge",', "  ));"]);
    expect(hits).toHaveLength(1);
  });

  it("still ignores the neighbouring per-project and in-review keys", () => {
    expect(
      scan("neighbours", [
        'const a = prefMap.get(`auto_merge_disabled_${projectId}`) === "true";',
        'const b = prefMap.get("auto_merge_in_review") === "true";',
      ]),
    ).toEqual([]);
  });

  it("does not count PROSE about the forbidden shape, which the text scan did", () => {
    const hits = scan("prose", [
      '// Never write `prefMap.get("auto_merge") === "true"` — call isAutoMergeEnabled instead.',
      '/* prefs.get("auto_merge") !== "false" is the shape this guard forbids. */',
      "const message = 'prefMap.get(\"auto_merge\") === \"true\"';",
      "export const noop = () => message;",
    ]);
    expect(hits).toEqual([]);
  });
});
