#!/usr/bin/env node
// render.mjs — regenerate the human-facing markdown views from the assembled _coverage.json.
// Deterministic: _coverage-matrix.md (capability × status grid), _gaps.md (uncovered+partial
// grouped by capability), _priorities.md (every capability's top_gaps, ranked P-band then ROI).
//
// Usage: node render.mjs <verification-dir>

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const cov = JSON.parse(readFileSync(join(dir, "_coverage.json"), "utf8"));
const byCap = cov.summary.by_capability || {};
const slugs = Object.keys(byCap).sort();
const t = cov.summary.totals;

// group behaviours by capability slug (ref prefix = longest matching slug)
const slugSet = slugs.slice().sort((a, b) => b.length - a.length);
const capOf = (ref) => slugSet.find((s) => ref.startsWith(s + ".")) || ref.split(".")[0];
const behByCap = {};
for (const b of cov.behaviors) (behByCap[capOf(b.ref)] ??= []).push(b);

// ---- _coverage-matrix.md ----
let m = `# Coverage matrix — functional coverage by capability\n\n`;
m += `Generated from \`_coverage.json\` (\`render.mjs\`). **NOT line coverage** — a behaviour is\n`;
m += `"covered" only when a test asserts its observable outcome across its risk-relevant dimensions.\n\n`;
m += `**Overall: ${t.overall_score} — ${t.covered} covered · ${t.partial} partial · ${t.uncovered} uncovered across ${t.behaviors} behaviours in ${t.capabilities} capabilities.**\n\n`;
m += `| Capability | Score | Covered | Partial | Uncovered | Weakest dimensions |\n|---|--:|--:|--:|--:|---|\n`;
for (const s of slugs.sort((a, b) => (byCap[a].score ?? 0) - (byCap[b].score ?? 0))) {
  const c = byCap[s];
  m += `| ${s} | ${fmt(c.score)} | ${c.covered ?? "?"} | ${c.partial ?? "?"} | ${c.uncovered ?? "?"} | ${(c.weak_dimensions || []).join(", ")} |\n`;
}
m += `\n_Sorted weakest-first. \`permission\`/\`accessibility\`/\`cross-browser\` are N/A for most API capabilities of this single-user local app and are not counted as gaps._\n`;
writeFileSync(join(dir, "_coverage-matrix.md"), m);

// ---- _gaps.md ----
let g = `# Coverage gaps — all capabilities\n\n`;
g += `Every behaviour that is not \`covered\`, grouped by capability. \`partial\` = touched/some-dimensions; \`uncovered\` = no asserting test. Lead with the five-way taxonomy counts.\n\n`;
g += `**Totals:** ${t.covered} covered · ${t.partial} partial · ${t.uncovered} uncovered · ${t.undocumented_implemented} undocumented-implemented · ${t.documented_missing} documented-missing.\n\n`;
for (const s of slugs) {
  const gaps = (behByCap[s] || []).filter((b) => b.status !== "covered");
  if (!gaps.length) continue;
  g += `## ${s} (${byCap[s].covered ?? "?"}/${(byCap[s].covered ?? 0) + (byCap[s].partial ?? 0) + (byCap[s].uncovered ?? 0)} covered)\n\n`;
  for (const b of gaps.sort((a, x) => rank(a.status) - rank(x.status))) {
    const why = b.gap?.rationale || b.gap?.kind || "";
    const miss = (b.dimensions_missing || b.gap?.missing_dimensions || []).join(", ");
    g += `- **[${b.status}]** \`${b.ref}\`${miss ? ` _(missing: ${miss})_` : ""} — ${trim(why)}\n`;
  }
  g += `\n`;
}
writeFileSync(join(dir, "_gaps.md"), g);

// ---- _priorities.md ----
const rows = [];
for (const s of slugs) for (const tg of byCap[s].top_gaps || []) rows.push({ cap: s, ...tg });
const pOrder = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };
rows.sort((a, b) => (pOrder[a.priority] ?? 9) - (pOrder[b.priority] ?? 9) || (b.roi ?? 0) - (a.roi ?? 0));
let p = `# Verification priorities — ROI-ranked backlog (all capabilities)\n\n`;
p += `Aggregated from each capability's \`top_gaps\` (see per-capability files in \`capabilities/\` for full behaviour context). Ranked P-band then ROI. ROI = (business_impact × regression_value) / (exec_cost + maint_cost).\n\n`;
p += `> The detailed, self-contained gap specs for the \`workspaces\` capability (the first authored slice) and the post-merge cascade follow-up live in git history of this file; one of them (\`workspaces.cascade.post-merge-followups\`) is already CLOSED — see \`_authored.json\`.\n\n`;
p += `| Rank | P | ROI | Capability | Behaviour | Dimensions to add | Why |\n|--:|---|--:|---|---|---|---|\n`;
rows.forEach((r, i) => {
  p += `| ${i + 1} | ${r.priority} | ${fmt(r.roi)} | ${r.cap} | \`${r.ref}\` | ${(r.dimensions_to_add || []).join(", ")} | ${trim(r.rationale)} |\n`;
});
p += `\n_${rows.length} ranked gaps. Author top-down with the \`e2e-test-author\` skill; stop at the ROI bar you set._\n`;
writeFileSync(join(dir, "_priorities.md"), p);

function fmt(n) { return n == null ? "?" : (+n).toFixed(2); }
function rank(s) { return { uncovered: 0, partial: 1 }[s] ?? 2; }
function trim(s) { return String(s || "").replace(/\s+/g, " ").slice(0, 240); }

console.log(`rendered matrix + gaps + priorities (${rows.length} ranked gaps, ${cov.behaviors.length} behaviours)`);
