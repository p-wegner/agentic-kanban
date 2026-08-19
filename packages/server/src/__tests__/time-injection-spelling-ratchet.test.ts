// @gate:always-run — scans every package's src tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * One vocabulary for injected time (#614).
 *
 * CLAUDE.md names `now?: string` for services that persist timestamps. In practice the
 * same parameter is spelled NINE ways across 178 declarations, which is why a reader
 * cannot tell whether a function is time-injectable without opening it, and why new code
 * picks whichever spelling it saw last.
 *
 * Two sanctioned spellings, because there are genuinely two jobs:
 *   - `now?: string`   — ISO, for code that PERSISTS the value (it goes into a column).
 *   - `nowMs?: number` — epoch ms, for pure arithmetic (ageMs, TTL comparisons).
 * Everything else is grandfathered at today's count and may only shrink.
 *
 * Deliberately a SPELLING ratchet, not the raw-`Date.now()` ratchet the ticket proposes.
 * That one keys off a staleness VOCABULARY (`stale|expir|ttl|ageMs|idle` near a date
 * call), and measuring it produced 51 candidate files whose majority are `updatedAt:
 * new Date().toISOString()` writes — legitimate timestamp writes, not staleness reads.
 * A baseline dominated by false positives trains people to add entries instead of
 * catching drift. Spellings are exact: they match a type annotation or nothing.
 */
const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const SCAN_ROOTS = ["server/src", "shared/src", "mcp-server/src", "client/src"];

/**
 * A `now`-ish parameter/property TYPE ANNOTATION. The trailing lookahead is load-bearing:
 * without it, `nowMs: Date.now()` (an object property, not an annotation) matches as
 * `nowMs: Date` and the census reports two misnamed declarations that do not exist.
 */
const NOW_PARAM =
  /\b(now|nowMs|nowIso|nowOverride|nowDate|clock)\??\s*:\s*(string|number|Date|\(\)\s*=>\s*(?:number|Date))\s*(?=[,)\];}=\n])/g;

const SANCTIONED = new Set(["now: string", "nowMs: number"]);

/** Non-canonical spellings, `<spelling>` → count. Only ever lower these. */
const BASELINE: Record<string, number> = {
  "now: Date": 32,
  "now: number": 17,
  "nowIso: string": 9,
  "nowOverride: string": 6,
  "now: () => Date": 4,
  "now: () => number": 4,
  "nowMs: () => number": 2,
};

/** #583 — the tree walk every guard suite needs, from the one shared helper. */
const sourceFiles = (rel: string): string[] => walkPackageSources(path.join(packagesRoot, rel));

function spellingCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(root)) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(NOW_PARAM)) {
        const spelling = `${m[1]}: ${m[2].replace(/\s+/g, " ")}`;
        if (SANCTIONED.has(spelling)) continue;
        counts[spelling] = (counts[spelling] ?? 0) + 1;
      }
    }
  }
  return counts;
}

describe("injected-time parameter spelling is ratcheted (#614)", () => {
  const counts = spellingCounts();

  it("finds now-parameters at all, so the ratchet cannot pass vacuously", () => {
    // The sanctioned pair alone is >100 declarations; if this scan ever returns nothing
    // the regex has broken, not the codebase.
    const all = SCAN_ROOTS.flatMap(sourceFiles)
      .map((f) => [...fs.readFileSync(f, "utf8").matchAll(NOW_PARAM)].length)
      .reduce((a, b) => a + b, 0);
    expect(all).toBeGreaterThan(100);
  });

  it("no NEW non-canonical spelling, and no existing one grows", () => {
    const over = Object.entries(counts)
      .filter(([sp, n]) => n > (BASELINE[sp] ?? 0))
      .map(([sp, n]) => `${sp}: ${n} > baseline ${BASELINE[sp] ?? 0}`);
    expect(
      over,
      "Use `now?: string` (ISO, persisted) or `nowMs?: number` (epoch ms, arithmetic):\n" +
        over.join("\n"),
    ).toEqual([]);
  });

  it("no baseline entry is stale (the ratchet only tightens)", () => {
    const stale = Object.entries(BASELINE)
      .filter(([sp, n]) => (counts[sp] ?? 0) < n)
      .map(([sp, n]) => `${sp}: baseline ${n}, actual ${counts[sp] ?? 0} — lower or delete it`);
    expect(stale, stale.join("\n")).toEqual([]);
  });
});
