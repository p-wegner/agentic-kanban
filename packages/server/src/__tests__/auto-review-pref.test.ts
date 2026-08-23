// @gate:always-run — scans the packages tree for hand-rolled auto_review reads; that half has no import edge (#647).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  AUTO_REVIEW_DEFAULT_ENABLED,
  AUTO_REVIEW_PREF_KEY,
  isAutoReviewEnabled,
} from "@agentic-kanban/shared/lib/auto-review-pref";
import {
  parseGuardSource,
  forEachNode,
  lineOf,
  unwrapExpression,
  calleeName,
} from "../../../shared/__tests__/helpers/guard-scan.js";

describe("isAutoReviewEnabled — canonical auto_review accessor (#946)", () => {
  it("defaults to ENABLED when the key is unset", () => {
    // Regression: exit-workflow / stranded-review reconciler / client used `!== "false"`
    // (default ON) while project-runtime-config (drive status + preflight) used
    // `=== "true"` (default OFF). With the key unset the dashboard said review OFF
    // while the exit workflow actually ran reviews. The canonical default is ON.
    expect(AUTO_REVIEW_DEFAULT_ENABLED).toBe(true);
    expect(AUTO_REVIEW_PREF_KEY).toBe("auto_review");
    expect(isAutoReviewEnabled(undefined)).toBe(true);
    expect(isAutoReviewEnabled(null)).toBe(true);
  });

  it("is enabled for the explicit string 'true'", () => {
    expect(isAutoReviewEnabled("true")).toBe(true);
  });

  it("is disabled ONLY for the explicit string 'false'", () => {
    expect(isAutoReviewEnabled("false")).toBe(false);
  });

  it("treats any other non-empty value as enabled (default-ON semantics)", () => {
    expect(isAutoReviewEnabled("")).toBe(true);
    expect(isAutoReviewEnabled("1")).toBe(true);
  });
});

/**
 * Scan server + mcp-server + client src for raw `auto_review` reads that hand-roll a
 * default (`=== "true"` / `!== "false"`) instead of going through isAutoReviewEnabled. The
 * GLOBAL key is `auto_review`; `skip_auto_review` / `skipAutoReview` are different flags
 * with their own intentional semantics, and matching the property NAME (rather than a
 * substring of a line) is what keeps them out.
 *
 * ## Why this is an AST pass and not a per-line regex (#794, following #779)
 *
 * The previous version tested `get("auto_review") ===` and `.auto_review ===` against one
 * LINE at a time — the shape #779 proved is not evidence. A read wrapped across two lines
 * carries neither half on a single line and is simply invisible, and nobody has to choose
 * that: a formatter breaking a long comparison is enough. A `BinaryExpression` is one node
 * however it is printed, so the wrap, an intervening `await` and added parentheses are all
 * invisible to IT instead; and because comments and string literals are not expressions,
 * prose about the forbidden shape stops counting as an instance of it.
 */
const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const scanRoots = [
  path.join(packagesRoot, "server", "src"),
  path.join(packagesRoot, "mcp-server", "src"),
  path.join(packagesRoot, "client", "src"),
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...listTsFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
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

/**
 * True for the two recognised raw reads of the global key, one node kind each:
 * `<anything>.get("auto_review")` (the prefMap style) and `<anything>.auto_review` /
 * `<anything>["auto_review"]` (the client Settings-record style).
 */
function readsAutoReviewKey(expr: ts.Expression): boolean {
  const node = unwrapExpression(expr);
  if (ts.isCallExpression(node) && calleeName(node) === "get") {
    const first = node.arguments[0];
    return !!first && ts.isStringLiteralLike(first) && first.text === AUTO_REVIEW_PREF_KEY;
  }
  if (ts.isPropertyAccessExpression(node)) return node.name.text === AUTO_REVIEW_PREF_KEY;
  if (ts.isElementAccessExpression(node)) {
    const argument = node.argumentExpression;
    return ts.isStringLiteralLike(argument) && argument.text === AUTO_REVIEW_PREF_KEY;
  }
  return false;
}

export interface AutoReviewHit {
  line: number;
  text: string;
}

/**
 * Every hand-rolled polarity read of the global `auto_review` key in one source text.
 * Exported so the proof cases below drive the REAL scanner rather than a copy of its
 * predicate.
 */
export function scanAutoReviewSource(cacheKey: string, text: string): AutoReviewHit[] {
  const sf = parseGuardSource(cacheKey, text);
  const hits: AutoReviewHit[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isBinaryExpression(node)) return;
    const op = node.operatorToken.kind;
    if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return;
    const readSide = isPolarityLiteral(node.right) ? node.left : isPolarityLiteral(node.left) ? node.right : null;
    if (!readSide || !readsAutoReviewKey(readSide)) return;
    hits.push({ line: lineOf(sf, node), text: node.getText(sf).replace(/\s+/g, " ").slice(0, 160) });
  });
  return hits;
}

describe("no contradictory auto_review defaults remain (#946)", () => {
  it("no server/mcp/client src reads the auto_review key with a hand-rolled default", () => {
    const offenders: string[] = [];
    for (const root of scanRoots) {
      for (const file of listTsFiles(root)) {
        const rel = path.relative(packagesRoot, file).replace(/\\/g, "/");
        for (const hit of scanAutoReviewSource(file, fs.readFileSync(file, "utf-8"))) {
          offenders.push(`${rel}:${hit.line}: ${hit.text}`);
        }
      }
    }
    expect(offenders, `Route these through isAutoReviewEnabled():\n${offenders.join("\n")}`).toEqual([]);
  });
});

/**
 * #779's proof obligation (#794): the conversion must catch the form the old per-line
 * version could not see, and still catch the ones it did.
 */
describe("the auto_review scan sees forms the per-line version could not (#794)", () => {
  const scan = (name: string, lines: string[]): AutoReviewHit[] =>
    scanAutoReviewSource(`/virtual/auto-review/${name}.ts`, lines.join("\n"));

  it("still catches both one-line shapes the regexes caught", () => {
    expect(scan("map-get", ['const on = prefMap.get("auto_review") === "true";'])).toHaveLength(1);
    expect(scan("record", ['const on = settings.auto_review !== "false";'])).toHaveLength(1);
  });

  it("catches the prefMap read WRAPPED across lines — the #779 evasion, verbatim", () => {
    const hits = scan("wrapped-get", ["const on =", '  prefMap.get("auto_review")', '    !== "false";']);
    expect(hits.map((h) => h.line)).toEqual([2]);
  });

  it("catches the settings-record read wrapped across lines", () => {
    const hits = scan("wrapped-record", ["const on = settings", "  .auto_review", '  === "true";']);
    expect(hits).toHaveLength(1);
  });

  it("still ignores the differently-named skip flag", () => {
    expect(
      scan("skip", [
        'const a = prefMap.get("skip_auto_review") === "true";',
        'const b = settings.skip_auto_review === "true";',
      ]),
    ).toEqual([]);
  });

  it("does not count PROSE about the forbidden shape, which the text scan did", () => {
    const hits = scan("prose", [
      '// Never write `settings.auto_review !== "false"` — call isAutoReviewEnabled instead.',
      '/* prefMap.get("auto_review") === "true" is the shape this guard forbids. */',
      "const message = 'settings.auto_review === \"true\"';",
      "export const noop = () => message;",
    ]);
    expect(hits).toEqual([]);
  });
});
