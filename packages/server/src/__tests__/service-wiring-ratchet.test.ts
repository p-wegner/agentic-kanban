// @gate:always-run — scans the whole services tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * ONE service-wiring vocabulary (#604).
 *
 * The repo is three months old and already has five co-existing wiring styles for one role,
 * which makes them parallel styles rather than eras: 63 `createXService(deps)` factories, 107
 * `doX(id, database)` fn-modules, module singletons, and direct use of the global `db`.
 *
 * The half that actually costs a reader is narrower than "five styles", and it is the same
 * defect #614 found in `now`: **the injection seam is spelled six ways**, so you cannot tell
 * whether a service is db-injectable — the thing you need to know to test it — without
 * opening it and reading the signature.
 *
 *   database: Database = db        47   <- sanctioned (fn-module)
 *   deps.database ?? db             6   <- sanctioned (factory)
 *   db: Database = realDb           7   grandfathered
 *   { database = db } destructure   2   grandfathered
 *   database: typeof db = db        1   grandfathered
 *   deps.db ?? realDb               1   grandfathered
 *
 * Two sanctioned spellings, because there are genuinely two shapes (see the doc row in
 * packages/server/CLAUDE.md). Everything else is frozen at today's count and may only shrink.
 *
 * The ticket proposed a different rule — "may import `{ db }` only if it also declares
 * `database: Database = db`". Measured, that flags 18 files of which most ARE properly
 * injectable, just in one of the other five spellings; it would have been a ratchet against
 * a spelling rather than against the defect.
 */
const servicesRoot = path.join(import.meta.dirname!, "..", "services");

const SPELLINGS: Record<string, RegExp> = {
  "database: Database = db": /\bdatabase\s*:\s*Database\s*=\s*(?:db|realDb)\b/g,
  "deps.database ?? db": /\b(?:deps|opts|options)\??\.database\s*\?\?\s*(?:db|realDb)\b/g,
  "db: Database = realDb": /\bdb\s*:\s*Database\s*=\s*realDb\b/g,
  "{ database = db } destructure": /\{[^}]*\bdatabase\s*=\s*(?:db|realDb)\b[^}]*\}/g,
  "database: typeof db = db": /\bdatabase\s*:\s*typeof db\s*=\s*db\b/g,
  "deps.db ?? realDb": /\b(?:deps|opts|options)\??\.db\s*\?\?\s*(?:db|realDb)\b/g,
};

const SANCTIONED = new Set(["database: Database = db", "deps.database ?? db"]);

/** Non-canonical seam spellings, `<spelling>` → count. **Only ever lower these.** */
const SPELLING_BASELINE: Record<string, number> = {
  "db: Database = realDb": 7,
  "{ database = db } destructure": 2,
  "database: typeof db = db": 1,
  "deps.db ?? realDb": 1,
};

/**
 * `export const xService = createXService({ database: db })` — a module singleton.
 *
 * Not banned: it is how a route gets a ready instance without wiring. But it pins the
 * service to the global db at MODULE LOAD, so a consumer cannot swap the database, and
 * `routes/config-export-import.ts` already builds its own `createPreferenceService({database})`
 * for the same service that `routes/butler.ts` used to take as a singleton. Frozen, shrink-only.
 */
const MODULE_SINGLETON = /^export const \w+ = create\w+(?:Service|Ops)\(/gm;
const MODULE_SINGLETON_BASELINE = 6;

/** `createXOps` — a second noun for the factory shape. Frozen; see the doc row. */
const OPS_FACTORY = /^export function (create\w+Ops)\(/gm;
const OPS_FACTORY_BASELINE = 5;

const IMPORTS_GLOBAL_DB = /import\s*\{[^}]*\bdb\b(?:\s+as\s+\w+)?[^}]*\}\s*from\s*["'][^"']*db\/index\.js["']/;
const ANY_SEAM = new RegExp(Object.values(SPELLINGS).map((r) => r.source).join("|"));
const EXPORTS_FACTORY = /^export function create\w+\s*\(/m;

const serviceFiles = walkPackageSources(servicesRoot);
const read = (f: string) => fs.readFileSync(f, "utf8");
const rel = (f: string) => path.relative(servicesRoot, f).split(path.sep).join("/");

function countAcross(pattern: RegExp): number {
  let total = 0;
  for (const file of serviceFiles) total += read(file).match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
  return total;
}

describe("service wiring vocabulary (#604)", () => {
  it("the scan reaches the services tree", () => {
    // A path typo would make every assertion below vacuously green.
    expect(serviceFiles.length).toBeGreaterThan(100);
  });

  it("non-canonical injection spellings only ever shrink", () => {
    for (const [spelling, baseline] of Object.entries(SPELLING_BASELINE)) {
      const found = countAcross(SPELLINGS[spelling]);
      expect(
        found,
        `"${spelling}" went ${baseline} → ${found}. Use "database: Database = db" (fn-module) ` +
          "or \"deps.database ?? db\" (factory); lower the baseline when it drops.",
      ).toBeLessThanOrEqual(baseline);
    }
  });

  it("no SEVENTH spelling appears", () => {
    // The failure mode this whole suite exists for: each new spelling was individually
    // reasonable, and six of them together are what make the seam unreadable.
    const known = new Set([...SANCTIONED, ...Object.keys(SPELLING_BASELINE)]);
    expect(Object.keys(SPELLINGS).filter((s) => !known.has(s))).toEqual([]);
  });

  it("every service that imports the global db exposes SOME way to inject one", () => {
    // Zero-tolerance, and currently zero: a service hard-wired to the global db cannot be
    // tested against a fixture database at all.
    const offenders = serviceFiles
      .filter((f) => {
        const text = read(f);
        if (!IMPORTS_GLOBAL_DB.test(text)) return false;
        return !ANY_SEAM.test(text) && !EXPORTS_FACTORY.test(text) && !MODULE_SINGLETON.test(text);
      })
      .map(rel);
    expect(
      offenders,
      "add a `database: Database = db` parameter (or a factory taking `{ database }`):\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("module singletons only ever shrink", () => {
    expect(countAcross(MODULE_SINGLETON)).toBeLessThanOrEqual(MODULE_SINGLETON_BASELINE);
  });

  it("the `Ops` factory noun only ever shrinks", () => {
    expect(countAcross(OPS_FACTORY)).toBeLessThanOrEqual(OPS_FACTORY_BASELINE);
  });

  it("the baselines are not stale", () => {
    // Same guard as #613's raw-query ratchet: without this a number silently becomes a
    // ceiling nobody is under, and the ratchet stops meaning anything.
    for (const [spelling, baseline] of Object.entries(SPELLING_BASELINE)) {
      expect(countAcross(SPELLINGS[spelling]), `lower the baseline for "${spelling}"`).toBe(baseline);
    }
    expect(countAcross(MODULE_SINGLETON), "lower MODULE_SINGLETON_BASELINE").toBe(MODULE_SINGLETON_BASELINE);
    expect(countAcross(OPS_FACTORY), "lower OPS_FACTORY_BASELINE").toBe(OPS_FACTORY_BASELINE);
  });
});
