// @gate:always-run — scans the services/ and startup/ trees; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  walkPackageSources,
  parseGuardSource,
  forEachNode,
  lineOf,
} from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * Server logs carry a `[tag]` prefix (#616).
 *
 * There is no logger module and no plan for one, so the convention IS the interface:
 * the prefix is what makes a ~1600-line server log greppable per subsystem, which is why
 * an untagged line is not a style nit — it is a line nobody will find later.
 *
 * A RATCHET, not a ban, because a good share of the survivors are legitimate:
 * `console.warn(warning)` / `console.warn(message)` forward a string that was already
 * tagged by its caller, and re-tagging there would double the prefix. Banning outright
 * would force those to be worked around; capping them stops the population growing while
 * leaving the judgement per-site.
 *
 * ## Why this is an AST pass and not a per-line regex (#779)
 *
 * It was two per-line regexes (`console\.(?:log|…)\(\s*(.)` for the call, a second one for
 * the tag) until #779, and both are defeated by a line break the author never thought about:
 *
 *     console.warn(
 *       `${workspaceId} went stale`,
 *     );
 *
 * The line holding `console.warn(` has nothing after the paren, so `\s*(.)` fails and the
 * call is not seen AT ALL — neither as tagged nor as untagged. That is the same defect
 * #947's pref-polarity ratchet was proven to have (a real violation hid in a multi-line
 * form for months and only surfaced when a reformat put it on one line), and prettier
 * wraps exactly the long interpolated messages most likely to need a tag.
 *
 * The two regexes also could not tell code from prose: a comment or a string containing
 * `console.log("…")` counted as a call, so the population check and the untagged cap were
 * both measuring documentation.
 *
 * A `CallExpression` on `console.<level>` is one node regardless of printing, and its first
 * argument is either a tag literal or it is not — so the shape match answers both halves
 * with no reference to line boundaries. NOT done by joining the file into one string: that
 * trades this false negative for matches spanning unrelated statements and still counts
 * comments.
 */
const SRC = path.join(import.meta.dirname!, "..");
const SCAN_DIRS = ["services", "startup"];

const CONSOLE_LEVELS = new Set(["log", "warn", "error", "info", "debug"]);
/**
 * A first argument OPENS with a tag when its leading LITERAL text starts with `[`. Looser
 * than the old regex's `\[[^\]]+\]` on purpose: `` console.log(`[${label}] done`) `` closes
 * the bracket after a substitution, so the old pattern read a perfectly tagged dynamic-tag
 * line as untagged (`script-runner.ts`, `plan-mode-exit.ts` — 6 such calls).
 */
const TAG_PREFIX = /^\[/;

export interface ConsoleCall {
  line: number;
  tagged: boolean;
}

/** `console.<level>(…)` written as a call — not mentioned in a comment or a string. */
function isConsoleCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "console") return false;
  return CONSOLE_LEVELS.has(callee.name.text);
}

/**
 * The literal that BEGINS an argument, following `+` concatenation and parentheses to their
 * leftmost operand. `console.warn("[worker] " + reason + hint)` is a tagged call, and the
 * concatenation is the form prettier reaches for when the message gets long — so a predicate
 * that only accepts a bare literal would classify ~60 tagged calls as untagged.
 */
function leadingLiteral(expr: ts.Expression): ts.Expression {
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.PlusToken) cur = cur.left;
    else return cur;
  }
}

/** Does the first argument start with a literal `[tag]`? */
function hasTagPrefix(call: ts.CallExpression): boolean {
  const first = call.arguments[0];
  if (!first) return false;
  const lead = leadingLiteral(first);
  if (ts.isStringLiteral(lead) || ts.isNoSubstitutionTemplateLiteral(lead)) return TAG_PREFIX.test(lead.text);
  // `` console.warn(`[monitor] ${id} stalled`) `` — the tag lives in the template HEAD, which
  // is the only part guaranteed to be a literal.
  if (ts.isTemplateExpression(lead)) return TAG_PREFIX.test(lead.head.text);
  return false;
}

/**
 * Every `console.*` call in one source, tagged or not. Named so #779's proof cases can drive
 * the REAL scanner over synthetic sources rather than a copy of its predicate.
 */
export function scanConsoleCalls(cacheKey: string, text: string): ConsoleCall[] {
  const sf = parseGuardSource(cacheKey, text);
  const calls: ConsoleCall[] = [];
  forEachNode(sf, (node) => {
    if (!isConsoleCall(node)) return;
    calls.push({ line: lineOf(sf, node), tagged: hasTagPrefix(node) });
  });
  return calls;
}

function scanTree(): { total: number; untagged: number; sample: string[] } {
  let total = 0;
  let untagged = 0;
  const sample: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walkPackageSources(path.join(SRC, dir))) {
      for (const call of scanConsoleCalls(file, fs.readFileSync(file, "utf8"))) {
        total++;
        if (call.tagged) continue;
        untagged++;
        if (sample.length < 10) {
          sample.push(`${path.relative(SRC, file).replaceAll("\\", "/")}:${call.line}`);
        }
      }
    }
  }
  return { total, untagged, sample };
}

/**
 * Untagged `console.*` calls in services/ + startup/. Only ever LOWER this.
 *
 * Unchanged at 21 across #779's conversion, which is the one number worth stating: the AST
 * pass sees **960** console calls in these trees where the per-line regex matched 802 lines,
 * so ~158 calls were outside the old scan's reach entirely — and every one of them turned out
 * to be tagged. The cap did not move, but until #779 nothing could have told us that; a green
 * ratchet over a population it cannot enumerate is not a measurement.
 */
const BASELINE_UNTAGGED = 21;

describe("server console logs carry a [tag] prefix (#616)", () => {
  const { total, untagged, sample } = scanTree();

  it("sees the console calls at all, so the scan cannot pass vacuously", () => {
    // 960 at #779. If the tag predicate stops matching, `untagged` would balloon rather than
    // vanish — so pin the population it is measuring against instead.
    expect(total).toBeGreaterThan(800);
  });

  it("does not add a new untagged console call", () => {
    expect(
      untagged,
      `Untagged console calls rose to ${untagged} (baseline ${BASELINE_UNTAGGED}).\n` +
        `Use console.<level>("[<tag>] …") with the file's existing subsystem tag.\n` +
        `First few untagged: ${sample.join(", ")}`,
    ).toBeLessThanOrEqual(BASELINE_UNTAGGED);
  });

  it("the baseline is not stale (lower it when calls are tagged)", () => {
    expect(
      untagged,
      `Only ${untagged} untagged calls remain — lower BASELINE_UNTAGGED to ${untagged}.`,
    ).toBeGreaterThanOrEqual(BASELINE_UNTAGGED);
  });
});

/**
 * #779's proof obligation: show the conversion catching what the per-line version could not.
 */
describe("the console scan sees forms the per-line version could not (#779)", () => {
  const scan = (name: string, lines: string[]): ConsoleCall[] =>
    scanConsoleCalls(`/virtual/console-tag/${name}.ts`, lines.join("\n"));

  it("counts a WRAPPED untagged call, which the old scan missed entirely", () => {
    // `console.warn(` ends its line, so the old `console\.\w+\(\s*(.)` never matched and the
    // call was neither tagged nor untagged — it simply did not exist for the ratchet.
    const calls = scan("wrapped-untagged", [
      "export function f(workspaceId: string) {",
      "  console.warn(",
      "    `${workspaceId} went stale`,",
      "  );",
      "}",
    ]);
    expect(calls).toEqual([{ line: 2, tagged: false }]);
  });

  it("counts a WRAPPED tagged call as tagged, so the fix is not to widen the cap", () => {
    const calls = scan("wrapped-tagged", ["console.error(", '  `[monitor] ${1} stalled`,', ");"]);
    expect(calls).toEqual([{ line: 1, tagged: true }]);
  });

  it("counts a concatenated tag as tagged — the wrapped form the old scan called untagged", () => {
    // `console.warn("[worker] " + reason + hint)` split over lines: the old TAGGED regex needed
    // the literal on the SAME line as the call, so a wrapped concatenation read as untagged
    // whenever the call line happened to match at all.
    const calls = scan("concat-tag", ["console.warn(", '  "[worker] " +', "    reason,", ");"]);
    expect(calls).toEqual([{ line: 1, tagged: true }]);
  });

  it("counts a DYNAMIC tag as tagged, which `\\[[^\\]]+\\]` could not", () => {
    // `[${label}]` closes the bracket after a substitution, so the old pattern rejected six
    // genuinely tagged calls (script-runner.ts, plan-mode-exit.ts).
    const calls = scan("dynamic-tag", ["const label = 'x';", "console.log(`[${label}] completed`);"]);
    expect(calls).toEqual([{ line: 2, tagged: true }]);
  });

  it("does not count a console call mentioned in a comment or a string", () => {
    const calls = scan("prose", [
      '// Prefer console.warn("[monitor] …") over a bare message.',
      '/* console.log(untagged) is what this ratchet counts. */',
      "const help = 'console.error(err)';",
      "export const noop = () => help;",
    ]);
    expect(calls).toEqual([]);
  });

  it("does not mistake a non-console logger of the same shape for one", () => {
    const calls = scan("other-logger", ["const log = { warn: (s: string) => s };", "log.warn(\"plain\");"]);
    expect(calls).toEqual([]);
  });
});
