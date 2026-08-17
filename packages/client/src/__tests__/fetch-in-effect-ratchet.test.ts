// @gate:always-run — scans the client src tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FETCH_IN_EFFECT_BASELINE } from "./fetch-in-effect-baseline.js";

/**
 * Fetch-in-effect is a DOWN-only ring (#603).
 *
 * 89 client modules call `apiFetch` from inside a module that also uses `useEffect`, each
 * re-deriving its own data/loading/error/cancelled ladder. #513 proposes
 * `useApiResource<T>()` to replace them; until that lands, the property worth enforcing is
 * that the count does not GROW — every new hand-rolled ladder is one more place to get
 * cancellation or a stale response wrong, and one more site to migrate later.
 *
 * The regex is why this is a test and not a one-line grep. `apiFetch\s*\(` — the obvious
 * spelling — matches exactly ONE file, because nearly every real call is generic
 * (`apiFetch<Thing>(...)`). A measurement that reports 1 instead of 89 does not merely
 * under-report: it reads as "already done" and closes the ticket. The optional `<...>`
 * group is load-bearing, and the first assertion below exists to catch its regression.
 *
 * This suite is also the first client-side guard that the pre-merge gate actually runs —
 * before #601, `packages/client` was not in `test-mine.mjs` at all.
 */
const CLIENT_SRC = path.join(import.meta.dirname!, "..");

/** `apiFetch(` or `apiFetch<T>(`. The generic form is the common one. */
const API_FETCH = /\bapiFetch\s*(?:<[^;{}]*?>)?\s*\(/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["__tests__", "node_modules", "dist"].includes(e.name)) out.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) out.push(full);
  }
  return out;
}

function currentCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sourceFiles(CLIENT_SRC)) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("useEffect")) continue;
    const n = (text.match(API_FETCH) ?? []).length;
    if (n > 0) counts[path.relative(CLIENT_SRC, file).replaceAll("\\", "/")] = n;
  }
  return counts;
}

describe("fetch-in-effect ladders are down-only (#603)", () => {
  const counts = currentCounts();

  it("sees the real tree — the generic-call regex must not silently under-report", () => {
    // Pinned high on purpose: the naive `apiFetch\s*\(` spelling finds 1 file. If this
    // ever drops to single digits the REGEX has broken, not the codebase.
    expect(Object.keys(counts).length).toBeGreaterThan(50);
  });

  it("no file gains a new fetch-in-effect ladder", () => {
    const over = Object.entries(counts)
      .filter(([f, n]) => n > (FETCH_IN_EFFECT_BASELINE[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} > baseline ${FETCH_IN_EFFECT_BASELINE[f] ?? 0}`);
    expect(
      over,
      "New hand-rolled fetch-in-effect. Prefer an existing data hook (or useApiResource\n" +
        "once #513 lands) over another data/loading/error/cancelled ladder:\n" +
        over.join("\n"),
    ).toEqual([]);
  });

  it("no baseline entry is stale (the ring only shrinks)", () => {
    const stale = Object.entries(FETCH_IN_EFFECT_BASELINE)
      .filter(([f, n]) => (counts[f] ?? 0) < n)
      .map(([f, n]) => `${f}: baseline ${n}, actual ${counts[f] ?? 0} — lower or delete it`);
    expect(stale, stale.join("\n")).toEqual([]);
  });
});
