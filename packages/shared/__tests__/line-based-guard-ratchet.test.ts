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
 * (`pref-polarity-ratchet`, `console-tag-ratchet`) and enumerated the remaining 13. This
 * suite is the DISCLOSURE half required by CLAUDE.md's partial-refactor rule: the remainder
 * cannot regrow silently, because a tree-scanning test that splits source into lines and is
 * not listed here fails this ratchet, and an entry whose file stopped doing it must be
 * removed.
 *
 * **#794 converted the last seven convertible ones and this list is now down to eight** —
 * `windows-hide-spawn-guard`, `auto-merge-pref`, `auto-review-pref`,
 * `client-conventions-guard`, `no-self-http-in-services`, `issue-number-single-source` and
 * `repository-projections-ratchet` all match shapes on the AST now, and `guard-scan.ts`
 * gained the `leadingCommentText` helper that the two comment-lookback opt-outs needed. Each
 * conversion paid for itself in findings the text scan could not see: a live self-HTTP call
 * hidden because a `"/*"` route path made `stripComments` blank 93 lines, 14 repository
 * projections re-spelled in a reordered form, and an allowlist kept green by prose after the
 * query it guarded had moved to another package.
 *
 * Being listed is not a verdict of "wrong". Two honest categories remain:
 *
 *   1. **line number for the MESSAGE only** — the match itself runs over the whole file text,
 *      so a wrap cannot hide anything; the split just turns an offset into `file:line`.
 *   2. **the subject genuinely IS lines** — a LOC ceiling, a markdown doc, a shell/JS hook
 *      script, CLAUDE.md prose. There is no AST to match against.
 *
 * A third category — **convertible, not yet converted** — is empty as of #794. If one comes
 * back, say what the wrap-shaped hole is at the entry, so the next session does not have to
 * re-derive it.
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
  "server/src/__tests__/claude-md-git-invariants.test.ts":
    "(2) the subject is CLAUDE.md prose and .claude/settings.json — there is no TypeScript AST " +
    "to match against, so lines are the only unit available.",
  "server/src/__tests__/env-read-ownership.test.ts":
    "(2) the AST pass owns the env READS since #768; the remaining line split parses " +
    "docs/env-vars.md, which is markdown.",
  "server/src/__tests__/executor-id-mapping-guard.test.ts":
    "(1) the regex runs over whole file text; the split converts `m.index` into a line number " +
    "for the offender message.",
  "server/src/__tests__/repository-table-ownership.test.ts":
    "(1) line number for the offender message only; the scan is over whole file text.",
  "server/src/__tests__/status-write-ratchet.test.ts":
    "(1) line number for the offender message only; the scan is over whole file text.",
  "server/src/__tests__/temp-dir-namespace-guard.test.ts":
    "(3) HONESTLY EVADABLE, and listed rather than dressed up as (1) or (2). Its three passes " +
    "match `mkdtemp(...)` / `join(tmpdir(), ...)` with a regex per line against real " +
    "TypeScript, so a call wrapped across two lines slips past exactly the way #779 describes. " +
    "It is NOT category (1) (the scan is genuinely per-line, not whole-text with a line number " +
    "for the message) and NOT category (2) (there is a TS AST here to match). The marker half " +
    "does need lines — `findOkMarker` walks the contiguous comment block above a site — but " +
    "that argues for an AST site scan feeding a line-based marker lookup, not for the whole " +
    "guard staying textual. Conversion is tracked; until then this entry is the disclosure.",
  "shared/__tests__/git-exec-single-spawn.test.ts":
    "(1) already an AST pass; the split quotes the offending source line in the message.",
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
    // 15 at #779 (after pref-polarity and console-tag were converted off lines), 8 at #794
    // (after the seven convertible ones went to AST shape matching). The floor stays well
    // below the current count: it exists to catch a broken WALK, not to pin the number —
    // the list itself does that, in both directions.
    expect(found.length).toBeGreaterThan(4);
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
