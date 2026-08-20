// @gate:always-run — scans the shared source tree and reads the pattern-language spec;
// imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkPackageSources } from "./helpers/guard-scan.js";

/**
 * `shared/lib` is not one kind (#590).
 *
 * Seven different things live there — node-adapter, shared-db-op, key-derivation,
 * contract-codec, stream-parser, pure-policy/projection, telemetry-singleton — and only
 * ONE of them may touch persistence. The docs said "SSOT" / "single write authority"
 * seven times without ever naming the KIND, so nothing stopped a pure module from
 * reaching into `shared/schema`; the pattern spec lumped all 143 files into one
 * `shared-lib` element whose rule allowed `shared-schema`, which is the same as having
 * no rule at all.
 *
 * The spec now carries `shared-db-op` as its own element, and only it may reach
 * `shared-schema`. But the spec engine matches PATHS, not imports — so the element's
 * member list is a hand-written enumeration, and a hand-written list drifts. This suite
 * is the other half: it re-derives membership from the imports themselves and fails when
 * the two disagree, so a new db-op cannot be added without being classified.
 */
const sharedSrc = path.join(import.meta.dirname!, "..", "src");
const libRoot = path.join(sharedSrc, "lib");
const specPath = path.join(import.meta.dirname!, "..", "..", "..", "docs", "pattern-language", "pattern-language.json");

/**
 * An import OR re-export statement, multi-line tolerant. Two details are load-bearing:
 * `[\s\S]*?`, because the db-op modules import a dozen tables across several lines and a
 * line-anchored regex sees none of them; and `export … from`, because the package barrel
 * reaches `schema/` with `export * from "./schema/index.js"` — an import-only scan reports
 * the barrel as clean while the spec engine, which counts module edges, does not.
 */
const IMPORT = /(?:import|export)\s+(type\s+)?([\s\S]*?)from\s*["']([^"']+)["']/g;

function valueImports(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT)) {
    const [, typeKeyword, clause, source] = m;
    if (typeKeyword) continue;
    const inner = clause.trim().replace(/^\{|\}$/g, "").trim();
    // `import { type A, type B } from …` is erased at compile time exactly like
    // `import type` — counting it produces phantom edges.
    if (inner && inner.split(",").every((part) => !part.trim() || part.trim().startsWith("type "))) continue;
    out.push(source);
  }
  return out;
}

const relLib = (abs: string) => path.relative(libRoot, abs).split(path.sep).join("/");

/** A drizzle query builder is what makes a module a db-op — the tables alone do not. */
function isDbOp(file: string): boolean {
  return valueImports(file).some((s) => s === "drizzle-orm" || s.startsWith("drizzle-orm/"));
}

function readsSchema(file: string): boolean {
  return valueImports(file).some((s) => /(^|\/)schema(\/|\.js$)/.test(s) && !s.endsWith("-schema.js"));
}

function specDbOpMembers(): string[] {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as {
    elements: { name: string; match: string[] }[];
  };
  const element = spec.elements.find((e) => e.name === "shared-db-op");
  if (!element) throw new Error("pattern-language.json has no `shared-db-op` element");
  return element.match
    .map((m) => m.replace(/^packages\/shared\/src\/lib\//, "").replace(/\\.ts\$$/, ""))
    .sort();
}

/**
 * `lib/` plus the package barrel — the spec's `shared-lib` element matches both, so a guard
 * that scanned only `lib/` would leave the barrel's schema edge unaccounted for while the
 * map claims it is frozen.
 */
const libFiles = [...walkPackageSources(libRoot), path.join(sharedSrc, "index.ts")];

/**
 * Pure modules that read `shared/schema` for a legitimate reason, frozen. Only ever
 * REMOVE from this list — a new entry means a new pure module reached into persistence
 * and must be justified in review rather than waved through.
 */
const SCHEMA_READ_EXCEPTIONS: Record<string, string> = {
  "../index.ts":
    "the PACKAGE BARREL — re-exporting `schema/index.js` is what a barrel is for; it " +
    "classifies as `shared-lib` only because the spec element's match includes " +
    "`packages/shared/src/index.ts`.",
  "dependency-type-traits.ts":
    "reads the DEPENDENCY_TYPES `as const` column VOCABULARY, not a table — the " +
    "`shared-schema` element intent explicitly blesses vocabularies living next to their " +
    "tables, and the file's own header records why the predicates cannot live in schema/ " +
    "(routes and the CLI ask them, and both are forbidden to import persistence).",
};

describe("shared/lib sub-kinds (#590)", () => {
  it("the spec's `shared-db-op` members are exactly the drizzle-importing modules", () => {
    const derived = libFiles.filter(isDbOp).map(relLib).map((p) => p.replace(/\.ts$/, "")).sort();
    expect(derived.length).toBeGreaterThan(0);
    expect(specDbOpMembers()).toEqual(derived);
  });

  it("no module outside `shared-db-op` value-imports drizzle-orm", () => {
    const members = new Set(specDbOpMembers());
    const strays = libFiles
      .filter(isDbOp)
      .map(relLib)
      .filter((p) => !members.has(p.replace(/\.ts$/, "")));
    expect(strays).toEqual([]);
  });

  it("no pure module reaches `shared/schema` outside the frozen exception list", () => {
    const dbOps = new Set(libFiles.filter(isDbOp).map(relLib));
    const offenders = libFiles
      .filter((f) => readsSchema(f))
      .map(relLib)
      .filter((p) => !dbOps.has(p) && !(p in SCHEMA_READ_EXCEPTIONS));
    expect(offenders).toEqual([]);
  });

  it("every frozen exception still exists and still reads schema (the list may only shrink)", () => {
    for (const name of Object.keys(SCHEMA_READ_EXCEPTIONS)) {
      const abs = path.join(libRoot, name);
      expect(fs.existsSync(abs), `${name} is gone — drop it from SCHEMA_READ_EXCEPTIONS`).toBe(true);
      expect(readsSchema(abs), `${name} no longer reads schema — drop it from SCHEMA_READ_EXCEPTIONS`).toBe(true);
    }
  });

  it("the spec forbids `shared-lib` reaching `shared-schema` (the rule that gives this teeth)", () => {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as { rules: Record<string, string[]> };
    expect(spec.rules["shared-lib"]).not.toContain("shared-schema");
    expect(spec.rules["shared-db-op"]).toContain("shared-schema");
  });
});
