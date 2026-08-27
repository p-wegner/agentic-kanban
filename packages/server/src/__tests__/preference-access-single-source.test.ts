// @gate:always-run — scans every package's src tree and reads the shared key table; imports
// nothing it checks except that table.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";
import {
  PROJECT_SCOPED_KEY_PREFIXES,
  boardStrategyPref,
  isBoardStrategyPreferenceKey,
} from "@agentic-kanban/shared/lib/dynamic-preference-keys";

/**
 * Preferences are "the most drift-prone surface" (CLAUDE.md), in two independent ways (#613).
 *
 *  1. WHO may query the table. Eight repositories had hand-rolled their own
 *     `getAllPreferences` / `getPreferenceValue` — with three different null-vs-undefined
 *     contracts between them — and 20 files outside the repository layer queried
 *     `preferences` directly, so a change to how a preference is read (caching, metrics,
 *     normalization) reached some callers and not others. The clones now delegate; this
 *     ratchet stops the raw-query count growing back.
 *
 *  2. HOW a per-project key is SPELLED. `projectPref(prefix)` builds and parses one family
 *     in one place, and the prefix table types it — but a backtick literal bypasses both.
 *     `board_strategy_${projectId}` was written out eleven times INCLUDING a second deriver
 *     in the client, for the preference CLAUDE.md calls the single source of truth for
 *     provider selection.
 */
const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const repoRoot = path.join(packagesRoot, "..");
const SCAN_ROOTS = ["server/src", "shared/src", "mcp-server/src", "client/src"];

const RAW_PREFERENCE_QUERY = /\bfrom\(\s*(?:schema\.)?preferences\s*\)/;

const relFromRepo = (abs: string) => path.relative(repoRoot, abs).split(path.sep).join("/");

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function filesWithRawPreferenceQuery(): string[] {
  const hits: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walkPackageSources(path.join(packagesRoot, root))) {
      if (RAW_PREFERENCE_QUERY.test(stripComments(fs.readFileSync(file, "utf8")))) {
        hits.push(relFromRepo(file));
      }
    }
  }
  return hits.sort();
}

/**
 * Files that query `preferences` directly today, frozen. **Only ever LOWER this.**
 *
 * Not zero-tolerance, deliberately: three of these are legitimate and permanent —
 * `preferences.repository.ts` IS the reader, `shared/lib/checked-preference-write.ts` is the
 * single write authority, and `mcp-server/src/db-utils.ts` is the MCP side's equivalent
 * (`mcp-no-server-internals` forbids it importing the server's repository). The rest are the
 * backlog this ticket names. A zero-tolerance rule here would have to be either a lie or a
 * 30-entry allow-list indistinguishable from this number.
 *
 * 34 -> 28 in this commit: the six server files that ran an UNCACHED full-table scan now go
 * through `getAllPreferencesCached`. That cache exists because timers alone drove ~10 full
 * scans per minute (#402), and every raw scan silently opted out of it.
 */
const RAW_PREFERENCE_QUERY_BASELINE = 29;

describe("preference ACCESS is single-source (#613)", () => {
  it("the raw-query count only ever shrinks", () => {
    const hits = filesWithRawPreferenceQuery();
    expect(
      hits.length,
      "a NEW file queries `preferences` directly. Use `getPreference`/`getAllPreferences` " +
        "from repositories/preferences.repository (or mcp-server's db-utils on that side):\n" +
        hits.join("\n"),
    ).toBeLessThanOrEqual(RAW_PREFERENCE_QUERY_BASELINE);
  });

  it("the baseline is not stale — lower it when the count drops", () => {
    // Without this the number silently becomes a ceiling nobody is under, and the ratchet
    // stops meaning anything the moment someone migrates a batch without updating it.
    expect(filesWithRawPreferenceQuery().length).toBe(RAW_PREFERENCE_QUERY_BASELINE);
  });

  it("the canonical reader is among them (the scan actually works)", () => {
    expect(filesWithRawPreferenceQuery()).toContain(
      "packages/server/src/repositories/preferences.repository.ts",
    );
  });
});

describe("per-project preference KEYS are built, not spelled (#613)", () => {
  /** `\`<registered_prefix>_${…}\`` — a key family that has a builder, written by hand. */
  const inlineKeyPattern = new RegExp(
    "`(?:" + PROJECT_SCOPED_KEY_PREFIXES.join("|") + ")_\$\{",
  );

  /**
   * The key module itself, and the two settings surfaces that legitimately compose key
   * strings from a prefix variable rather than from a family.
   */
  const SANCTIONED = new Set([
    "packages/shared/src/lib/dynamic-preference-keys.ts",
  ]);

  it("no file hand-writes a key for a family that has a builder", () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walkPackageSources(path.join(packagesRoot, root))) {
        const rel = relFromRepo(file);
        if (SANCTIONED.has(rel)) continue;
        if (inlineKeyPattern.test(stripComments(fs.readFileSync(file, "utf8")))) offenders.push(rel);
      }
    }
    expect(
      offenders,
      "use `projectPref(\"<prefix>\").key(projectId)` — or the exported family, e.g. " +
        "`boardStrategyPref.key(projectId)`:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("the board-strategy builder and its recognizer agree", () => {
    // They are separate functions with separate regexes: the recognizer accepts a looser
    // suffix than the table's strict UUID shape, deliberately, so it is not narrowed here.
    // What must hold is that anything the BUILDER produces the RECOGNIZER accepts — the
    // direction a drift would actually break.
    const projectId = "d1c5d9c1-4897-4e1b-acc3-2aa96de04117";
    const key = boardStrategyPref.key(projectId);
    expect(key).toBe(`board_strategy_${projectId}`);
    expect(isBoardStrategyPreferenceKey(key)).toBe(true);
    expect(boardStrategyPref.projectIdOf(key)).toBe(projectId);
  });

  it("board_strategy is registered in the prefix table", () => {
    // It was absent for its whole life, which is why `projectPref` could not be used for it.
    expect(PROJECT_SCOPED_KEY_PREFIXES).toContain("board_strategy");
  });
});
