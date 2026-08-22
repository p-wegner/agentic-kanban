// @gate:always-run — enumerates every guard suite in the repo by walking the test tree; imports none of them (#779).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkTestFiles, compareRatchet } from "./helpers/guard-scan.js";

/**
 * #779 — a guard suite that matches a regex PER LINE is evadable by a line wrap, so the
 * population of such suites is itself something that has to be tracked.
 *
 * The proof this exists for: `pref-polarity-ratchet.test.ts` was GREEN on a tree containing
 * exactly what it forbids. `plugin-loop.service.ts` read
 * `(await getPreference(key, db)) === "true"` wrapped across two lines for months — neither
 * line carried both halves — and the violation only appeared when #727's reformat put it on
 * one line. A guard whose verdict depends on where a formatter wrapped is not evidence, and
 * the evasion is undeliberate: any editor that wraps a long expression grants an exemption
 * nobody chose.
 *
 * #779 converted the two highest-value offenders to AST shape matching
 * (`pref-polarity-ratchet`, `console-tag-ratchet`). The rest are listed below. This suite is
 * the DISCLOSURE half required by CLAUDE.md's partial-refactor rule: the remainder cannot
 * regrow silently, because a tree-scanning test that splits source into lines and is not
 * listed here fails this ratchet, and an entry whose file stopped doing it must be removed.
 *
 * Being listed is not a verdict of "wrong". Three honest categories share the list:
 *
 *   1. **line number for the MESSAGE only** — the match itself runs over the whole file text,
 *      so a wrap cannot hide anything; the split just turns an offset into `file:line`.
 *   2. **the subject genuinely IS lines** — a LOC ceiling, a markdown doc, a shell/JS hook
 *      script, a run of consecutive literal lines. There is no AST to match against.
 *   3. **convertible, not yet converted** — the #779 remainder. Each says what the wrap-shaped
 *      hole is, so the next session does not have to re-derive it.
 */

const testModuleDir = path.dirname(fileURLToPath(import.meta.url));
const packagesRoot = path.resolve(testModuleDir, "..", "..");
const SELF = "shared/__tests__/line-based-guard-ratchet.test.ts";

/**
 * Assembled from fragments so this file's own source does not match its own detector — the
 * detector looks for these literals, and a guard that reports itself is noise.
 */
const NEWLINE_SPLITS = [
  `.split(${"/"}\\r?\\n${"/"})`,
  `.split(${'"'}\\n${'"'})`,
  `.split(${"/"}\\n${"/"})`,
];
/** A test whose subject is the repo TREE rather than a module — the guard-suite kind (#583). */
const TREE_SCAN = /walkPackageSources|walkTestFiles|readdirSync|globSync/;

/**
 * Every tree-scanning guard suite that splits file text into lines, with WHY it still does.
 * Category (1)/(2)/(3) per the header. Only ever SHRINK this list.
 */
const LINE_BASED_GUARDS: Record<string, string> = {
  "client/src/__tests__/client-conventions-guard.test.ts":
    "(3) per-line `fetch(` / `history.pushState` match, plus a two-line LOOKBACK for the " +
    "`eslint-disable-next-line no-restricted-syntax` exemption. The match converts easily; the " +
    "lookback is the work, because an exemption comment is not an AST node — it needs " +
    "ts.getLeadingCommentRanges, not forEachNode.",
  "server/src/__tests__/auto-merge-pref.test.ts":
    "(3) zero-tolerance `get(\"auto_merge\") ===` per-line ban — wrap-evadable in exactly the way " +
    "#947's was. Partly covered meanwhile: pref-polarity-ratchet is AST since #779 and would " +
    "report a wrapped read as a NEW `auto_merge` key. Outside #779's file allowlist.",
  "server/src/__tests__/auto-review-pref.test.ts":
    "(3) same shape and same partial cover as auto-merge-pref, for `auto_review`.",
  "server/src/__tests__/claude-md-git-invariants.test.ts":
    "(2) the subject is CLAUDE.md prose and .claude/settings.json — there is no TypeScript AST " +
    "to match against, so lines are the only unit available.",
  "server/src/__tests__/env-read-ownership.test.ts":
    "(2) the AST pass owns the env READS since #768; the remaining line split parses " +
    "docs/env-vars.md, which is markdown.",
  "server/src/__tests__/executor-id-mapping-guard.test.ts":
    "(1) the regex runs over whole file text; the split converts `m.index` into a line number " +
    "for the offender message.",
  "server/src/__tests__/no-self-http-in-services.test.ts":
    "(3) per-line `fetch(\"http://127.0.0.1…\")` with a preceding-line `SELF-HTTP OK:` opt-out — " +
    "the same comment-lookback problem as client-conventions-guard.",
  "server/src/__tests__/repository-projections-ratchet.test.ts":
    "(2)+(3) one check matches a RUN of consecutive column lines re-spelled out of " +
    "projections.ts, i.e. its subject really is the text layout. An AST version would compare " +
    "object-literal member SETS, which is strictly better and strictly more work.",
  "server/src/__tests__/repository-table-ownership.test.ts":
    "(1) line number for the offender message only; the scan is over whole file text.",
  "server/src/__tests__/status-write-ratchet.test.ts":
    "(1) line number for the offender message only; the scan is over whole file text.",
  "server/src/__tests__/windows-hide-spawn-guard.test.ts":
    "(3) finds a spawn call on a line, then joins the NEXT 16 lines and counts parens to find " +
    "the options object. A CallExpression's arguments are one node — this is the clearest " +
    "conversion left, and it is outside #779's file allowlist.",
  "shared/__tests__/git-exec-single-spawn.test.ts":
    "(1) already an AST pass; the split quotes the offending source line in the message.",
  "shared/__tests__/issue-number-single-source.test.ts":
    "(3) per-line match for hand-rolled issue-number derivation; convertible, outside #779's " +
    "file allowlist.",
  "shared/__tests__/max-file-size.test.ts":
    "(2) it COUNTS lines — a LOC ceiling's unit of measure is the line — and separately scans a " +
    "`.js` hook script body, which this repo's TS parser is not pointed at.",
  "shared/__tests__/worktree-delete-guard-ratchet.test.ts":
    "(1) already an AST pass; the split quotes the offending source line in the message.",
};

const rel = (abs: string): string => path.relative(packagesRoot, abs).replace(/\\/g, "/");

/** Tree-scanning test suites that split file text into lines. */
function detectLineBasedGuards(): string[] {
  const found: string[] = [];
  for (const file of walkTestFiles(packagesRoot)) {
    const relPath = rel(file);
    if (relPath === SELF) continue;
    const text = fs.readFileSync(file, "utf8");
    if (!TREE_SCAN.test(text)) continue;
    if (!NEWLINE_SPLITS.some((fragment) => text.includes(fragment))) continue;
    found.push(relPath);
  }
  return found.sort();
}

describe("line-based guard suites are enumerated and shrink-only (#779)", () => {
  const found = detectLineBasedGuards();

  it("finds guard suites at all, so this ratchet cannot pass vacuously", () => {
    // 15 at #779, after pref-polarity and console-tag were converted off lines.
    expect(found.length).toBeGreaterThan(8);
  });

  it("every line-based guard suite is listed with a reason, and no entry is stale", () => {
    const baseline = Object.fromEntries(Object.keys(LINE_BASED_GUARDS).map((k) => [k, 1]));
    const current = Object.fromEntries(found.map((k) => [k, 1]));
    const { over, stale } = compareRatchet(baseline, current);

    expect(
      over,
      [
        "A tree-scanning guard suite matches a regex per LINE and is not listed in",
        "LINE_BASED_GUARDS. A per-line guard is evadable by a line wrap — see #779, where",
        "pref-polarity-ratchet was green on a tree holding exactly what it forbids because a",
        "real violation sat in a two-line form.",
        "",
        "Either match the SHAPE on the AST (packages/shared/__tests__/helpers/guard-scan.ts:",
        "parseGuardSource / forEachNode / lineOf / unwrapExpression / calleeName), or add an",
        "entry here saying WHY lines are the right unit for this subject.",
        "",
        ...over,
      ].join("\n"),
    ).toEqual([]);

    expect(
      stale,
      [
        "These suites no longer split source into lines — delete their entries. A ratchet",
        "nobody lowers stops being a ceiling and becomes a budget:",
        "",
        ...stale,
      ].join("\n"),
    ).toEqual([]);
  });
});

/**
 * #779's proof obligation, applied to this meta-guard: it must actually go red on a NEW
 * line-based guard, not merely be green today.
 */
describe("the meta-guard reports an unlisted line-based guard (#779)", () => {
  it("classifies a synthetic tree-scanning, line-splitting suite as line-based", () => {
    const synthetic = [
      "import { walkPackageSources } from './helpers/guard-scan.js';",
      "const bad = /forbidden/;",
      "for (const f of walkPackageSources(root)) {",
      `  for (const line of read(f)${NEWLINE_SPLITS[0]}) if (bad.test(line)) fail(line);`,
      "}",
    ].join("\n");
    expect(TREE_SCAN.test(synthetic)).toBe(true);
    expect(NEWLINE_SPLITS.some((fragment) => synthetic.includes(fragment))).toBe(true);
    // …and an unlisted one is over-baseline, i.e. red.
    const { over } = compareRatchet(
      Object.fromEntries(Object.keys(LINE_BASED_GUARDS).map((k) => [k, 1])),
      { "server/src/__tests__/brand-new-guard.test.ts": 1 },
    );
    expect(over).toHaveLength(1);
  });

  it("does not flag an AST guard that never splits source into lines", () => {
    const good = [
      "import { walkPackageSources, parseGuardSource, forEachNode } from './helpers/guard-scan.js';",
      "for (const f of walkPackageSources(root)) forEachNode(parseGuardSource(f), (n) => check(n));",
    ].join("\n");
    expect(NEWLINE_SPLITS.some((fragment) => good.includes(fragment))).toBe(false);
  });
});
