#!/usr/bin/env node
// assemble.mjs — merge per-capability verification files into the shared model.
// Each capabilities/<slug>.json has { slug, behavior:{...}, coverage:{ behaviors:[...], summary:{...} } }.
// Produces consolidated _behavior-model.json + _coverage.json (preserving any pre-existing
// capability records not regenerated this run, e.g. the hand-authored workspaces slice).
//
// Usage: node assemble.mjs <verification-dir>

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: assemble.mjs <verification-dir>"); process.exit(1); }
const capDir = join(dir, "capabilities");
const files = readdirSync(capDir).filter((f) => f.endsWith(".json"));

const parts = files.map((f) => JSON.parse(readFileSync(join(capDir, f), "utf8")));

// --- behavior model ---
const bmPath = join(dir, "_behavior-model.json");
const bm = existsSync(bmPath)
  ? JSON.parse(readFileSync(bmPath, "utf8"))
  : { schema: "verification-model/behavior@1", capabilities: [] };
const bySlug = new Map(bm.capabilities.map((c) => [c.slug, c]));
for (const p of parts) if (p.behavior) bySlug.set(p.slug, p.behavior);
bm.capabilities = [...bySlug.values()];
bm.evidence_sources = [...new Set((bm.evidence_sources || []).concat(["domain-docs", "source", "tests"]))];
writeFileSync(bmPath, JSON.stringify(bm, null, 2) + "\n");

// --- coverage ---
const covPath = join(dir, "_coverage.json");
const cov = existsSync(covPath)
  ? JSON.parse(readFileSync(covPath, "utf8"))
  : { schema: "verification-model/coverage@1", behaviors: [], summary: { by_capability: {} } };
const covByRef = new Map(cov.behaviors.map((b) => [b.ref, b]));
cov.summary = cov.summary || { by_capability: {} };
cov.summary.by_capability = cov.summary.by_capability || {};
for (const p of parts) {
  if (!p.coverage) continue;
  for (const b of p.coverage.behaviors || []) covByRef.set(b.ref, b);
  if (p.coverage.summary) cov.summary.by_capability[p.slug] = p.coverage.summary;
}
cov.behaviors = [...covByRef.values()];

// roll up totals
const tally = { covered: 0, partial: 0, uncovered: 0, undocumented_implemented: 0, documented_missing: 0 };
for (const b of cov.behaviors) if (b.status in tally) tally[b.status]++;
cov.summary.totals = {
  ...tally,
  behaviors: cov.behaviors.length,
  capabilities: Object.keys(cov.summary.by_capability).length,
  overall_score: +(((tally.covered + 0.5 * tally.partial) / Math.max(1, cov.behaviors.length)).toFixed(3)),
};
writeFileSync(covPath, JSON.stringify(cov, null, 2) + "\n");

console.log(`assembled ${parts.length} capability files`);
console.log(`behaviors: ${cov.behaviors.length} | ${JSON.stringify(tally)} | score ${cov.summary.totals.overall_score}`);
console.log(`capabilities in model: ${bm.capabilities.length}`);
