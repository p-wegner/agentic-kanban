// @gate:always-run — recursively scans client src/lib and src/hooks; imports nothing it checks (#694).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * No upward import from `lib/` or `hooks/` into `components/` or `routes/` — **including
 * type-only** (#694).
 *
 * `9d9cce93be` drove these edges from 19 to 0 by moving declarations down, and it was honest
 * about the count. What it did not do was protect the result, and HEAD had regressed to 1
 * (`lib/gateCardPolicy.ts` importing three types from `../components/PluginLoopExtras.js`).
 *
 * **Why depcruise cannot be the guard here.** The rule that names this exact direction,
 * `client-hooks-not-up-to-components-or-routes` (`.dependency-cruiser.cjs`, severity `error`),
 * explicitly EXEMPTS type-only imports — its own comment reasons that type imports are erased at
 * compile time — and the config sets `tsPreCompilationDeps: false`, so depcruise does not even
 * resolve them. The blind spot that allowed the original 19 was therefore left fully intact
 * after they were fixed. A text scan is the only thing that can see an edge the resolver erases,
 * which is why this is a test and not another depcruise rule.
 *
 * **Why the direction matters even for types.** It is a layering claim, not a bundling one: the
 * point of `lib/` is that it is pure logic testable without rendering anything. A type reaching
 * up into a component means the component owns the vocabulary its own logic is written in, so the
 * logic cannot move or be reused without dragging the view along — and the next author reads the
 * import as permission to add a value import beside it.
 *
 * TEST files are exempt: a test for `lib/gateCardPolicy.ts` legitimately renders `GateCard` to
 * assert the policy drives it, and that is an edge from a test to a component, not from the
 * layer to the component.
 */

const clientSrc = path.join(import.meta.dirname!, "..");
const SCAN_DIRS = ["lib", "hooks"];

/** Any import/export whose specifier climbs into `components/` or `routes/`. Matches type-only
 *  (`import type`, `export type … from`) and value forms alike — the type-only ones are the
 *  whole point, since those are exactly what depcruise drops. */
const UPWARD_EDGE = /(?:import|export)[\s\S]{0,400}?from\s*["']\.\.\/(components|routes)\/[^"']*["']/g;

const IS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const IS_SOURCE = /\.[cm]?[jt]sx?$/;

function collectSources(dir: string, rel = ""): { rel: string; full: string }[] {
  const abs = rel ? path.join(dir, rel) : dir;
  if (!fs.existsSync(abs)) return [];
  const out: { rel: string; full: string }[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      out.push(...collectSources(dir, childRel));
      continue;
    }
    if (!IS_SOURCE.test(entry.name) || IS_TEST.test(entry.name)) continue;
    out.push({ rel: childRel, full: path.join(abs, entry.name) });
  }
  return out;
}

function upwardEdges(): string[] {
  const found: string[] = [];
  for (const layer of SCAN_DIRS) {
    for (const { rel, full } of collectSources(path.join(clientSrc, layer))) {
      const source = fs.readFileSync(full, "utf8");
      for (const m of source.matchAll(UPWARD_EDGE)) {
        const specifier = m[0].slice(m[0].lastIndexOf("from"));
        found.push(`${layer}/${rel} -> ${specifier.replace(/\s+/g, " ").trim()}`);
      }
    }
  }
  return found;
}

describe("client upward type-edge ratchet (#694)", () => {
  it("the scan reaches real files — a path typo would make the assertion vacuous", () => {
    const scanned = SCAN_DIRS.flatMap((d) => collectSources(path.join(clientSrc, d)));
    expect(scanned.length).toBeGreaterThan(20);
  });

  it("no lib/ or hooks/ module imports from components/ or routes/, type-only included", () => {
    const edges = upwardEdges();
    expect(
      edges,
      "A `lib/`or `hooks/` module must not import from `components/` or `routes/` — not even a " +
        "type. Move the declaration DOWN into the layer that needs it (see " +
        "lib/pluginLoopTypes.ts, extracted from PluginLoopExtras.tsx for exactly this) and " +
        "re-export it from the component if existing importers rely on that path. depcruise " +
        "will NOT catch this: its rule exempts type-only imports and tsPreCompilationDeps is " +
        `false, which is why this scan exists:\n  ${edges.join("\n  ")}`,
    ).toEqual([]);
  });

  it("detects an upward type-only edge when one is present", () => {
    // Proves the regex sees the erased form, not just value imports — the whole failure mode.
    const sample = 'import type { PluginGate } from "../components/PluginLoopExtras.js";';
    expect(new RegExp(UPWARD_EDGE.source).test(sample)).toBe(true);
    const valueSample = 'import { GateCard } from "../components/GateCard.js";';
    expect(new RegExp(UPWARD_EDGE.source).test(valueSample)).toBe(true);
    const sidewaysSample = 'import type { Foo } from "./pluginLoopTypes.js";';
    expect(new RegExp(UPWARD_EDGE.source).test(sidewaysSample)).toBe(false);
  });
});
