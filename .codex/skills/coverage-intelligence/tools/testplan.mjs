#!/usr/bin/env node
// testplan.mjs — render a LIVING, trackable test plan (Markdown) from the verification model.
// Analogue of a Playwright "planner" output, but GENERATED from the model so it never drifts:
// each scenario is one observable behaviour, and its checkbox is DERIVED from coverage status
// ([x] covered, [~] partial, [ ] gap). Joins _behavior-model.json (scenario/actor/expected) with
// _coverage.json (status/covering-test/gap). Re-run after any coverage change to refresh ticks.
//
// Usage: node testplan.mjs <verification-dir>

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const bm = JSON.parse(readFileSync(join(dir, "_behavior-model.json"), "utf8"));
const cov = JSON.parse(readFileSync(join(dir, "_coverage.json"), "utf8"));

const covByRef = new Map(cov.behaviors.map((b) => [b.ref, b]));
const caps = bm.capabilities.slice().sort((a, b) => a.slug.localeCompare(b.slug));
const t = cov.summary.totals;
const tick = { covered: "x", partial: "~", uncovered: " " };
const icon = { covered: "✅", partial: "⚠️", uncovered: "⬜" };
const bar = (frac, w = 20) => "█".repeat(Math.round(frac * w)) + "░".repeat(w - Math.round(frac * w));
const pOrder = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

let out = `# Verification Test Plan — agentic-kanban\n\n`;
out += `> **Living, generated plan — do not hand-edit checkboxes.** Each scenario is one observable\n`;
out += `> behaviour; the tick is derived from \`_coverage.json\` (\`testplan.mjs\`). Regenerate after\n`;
out += `> tests land and ticks update themselves — the plan can't drift from reality.\n\n`;
out += `**Progress: ${t.covered}/${t.behaviors} scenarios covered (${Math.round((t.covered / t.behaviors) * 100)}%)** · ${t.partial} partial · ${t.uncovered} to author\n\n`;
out += `\`[${bar(t.covered / t.behaviors)}]\`\n\n`;
out += `Pipeline roles (cf. Playwright Agents): **planner** = behavior-discovery + coverage-intelligence (this plan) · **generator** = e2e-test-author (implements gaps top-down) · **healer** = e2e-test-author re-run + flaky-test-triage (keeps the suite green).\n\n`;
out += `Legend: \`[x]\` ✅ covered (outcome asserted) · \`[~]\` ⚠️ partial (touched / dims missing) · \`[ ]\` ⬜ gap (priority shown).\n\n`;

// per-capability gap priority lookup (from coverage summary.by_capability top_gaps)
const gapPrio = {};
for (const [slug, s] of Object.entries(cov.summary.by_capability || {}))
  for (const tg of s.top_gaps || []) gapPrio[tg.ref] = tg;

// index
out += `## Index\n\n| Capability | Covered | Plan |\n|---|--:|---|\n`;
for (const c of caps) {
  const rows = c.behaviors.map((b) => covByRef.get(b.id)).filter(Boolean);
  const cv = rows.filter((r) => r.status === "covered").length;
  out += `| [${c.slug}](#${c.slug}) | ${cv}/${rows.length} | \`[${bar(rows.length ? cv / rows.length : 0, 10)}]\` |\n`;
}
out += `\n---\n\n`;

for (const c of caps) {
  const rows = c.behaviors.map((b) => ({ beh: b, cov: covByRef.get(b.id) })).filter((r) => r.cov);
  const cv = rows.filter((r) => r.cov.status === "covered").length;
  out += `## ${c.slug}\n\n`;
  out += `**${c.name}** — ${cv}/${rows.length} covered \`[${bar(rows.length ? cv / rows.length : 0, 10)}]\`\n\n`;

  // order: gaps first (by priority), then partial, then covered
  const order = (r) => r.cov.status === "uncovered" ? -10 + (pOrder[gapPrio[r.beh.id]?.priority] ?? 5)
    : r.cov.status === "partial" ? 10 : 20;
  rows.sort((a, b) => order(a) - order(b));

  for (const { beh, cov: cb } of rows) {
    const st = cb.status;
    const pr = st !== "covered" ? gapPrio[beh.id]?.priority : null;
    out += `- [${tick[st] ?? " "}] ${icon[st] ?? "⬜"} ${pr ? `**${pr}** ` : ""}\`${beh.id}\` — ${beh.statement || ""}\n`;
    if (beh.actor || (beh.entry_points && beh.entry_points[0]))
      out += `  - _given_ ${beh.actor || "actor"}${entry(beh) ? ` · _via_ ${entry(beh)}` : ""}\n`;
    if (beh.observable_outcome) out += `  - _then_ ${beh.observable_outcome}\n`;
    if (st === "covered") {
      const tests = (cb.covered_by || []).map((x) => x.test).filter(Boolean);
      if (tests.length) out += `  - _asserted by_ ${tests.map((x) => "`" + shortTest(x) + "`").join(", ")}\n`;
    } else {
      const miss = (cb.dimensions_missing || cb.gap?.missing_dimensions || []);
      if (miss.length) out += `  - _add dimensions_ ${miss.join(", ")}\n`;
      const why = cb.gap?.rationale;
      if (why) out += `  - _gap_ ${String(why).replace(/\s+/g, " ").slice(0, 220)}\n`;
    }
  }
  out += `\n`;
}

function entry(b) {
  const e = (b.entry_points || [])[0];
  return e ? (e.ref || e.kind || "") : "";
}
function shortTest(s) {
  const [file, title] = s.split("::");
  return (file.split("/").pop() || file) + (title ? `::${title.slice(0, 48)}` : "");
}

writeFileSync(join(dir, "_testplan.md"), out);
console.log(`wrote _testplan.md — ${t.covered}/${t.behaviors} scenarios covered across ${caps.length} capabilities`);
