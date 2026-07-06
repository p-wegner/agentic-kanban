import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * #947 — ratchet gate against raw preference polarity reads.
 *
 * Every hand-rolled `=== "true"` / `!== "false"` read of a preference value is a fresh
 * chance for the polarity bug class (#866 auto_merge, #946 auto_review): the SAME key
 * read with OPPOSITE unset-defaults in different files, so behaviour and surfaced
 * status disagree. The canonical way to read a bool preference is ONE accessor per
 * key — `getBool`/`parseBoolSetting` (registry-default-aware since #947,
 * `@agentic-kanban/shared/lib/settings-registry`) or a dedicated accessor
 * (isAutoReviewEnabled / isAutoMergeEnabled).
 *
 * This test scans server + mcp-server + client src for the recognizable raw-read
 * shapes and fails when a (file, key) pair EXCEEDS the checked-in baseline below.
 * Existing reads are grandfathered explicitly (dynamic per-project keys, tri-state
 * reads, DB-row `.value` shapes); NEW raw reads are red. Pattern: ratchet-only, like
 * COHESION_BASELINE in scripts/check-god-modules.mjs.
 *
 * When you migrate a key's reads to getBool/parseBoolSetting, REMOVE (or lower) its
 * baseline entries — the test also fails when an entry is stale, so the ratchet can
 * only tighten.
 */

const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const scanRoots = [
  path.join(packagesRoot, "server", "src"),
  path.join(packagesRoot, "mcp-server", "src"),
  path.join(packagesRoot, "client", "src"),
];

/**
 * Grandfathered raw polarity reads, `<file>::<key>` → count. `<row-value>` = a DB-row
 * `.value ===/!==` or `([key, value]) => value === "true"` filter shape where the key
 * is dynamic. Only SHRINK this list.
 */
const BASELINE: Record<string, number> = {
  "client/src/components/CreateWorkspaceForm.tsx::skip_preflight": 2,
  "client/src/components/CreateWorkspaceForm.tsx::tdd_mode": 1,
  "client/src/components/settings/ProviderRotationRingEditor.tsx::cfg.rotationSettingKey": 1,
  "client/src/components/WorkflowSections.tsx::auto_rebase_on_continue": 1,
  "client/src/components/WorkflowSections.tsx::butler_auto_answer": 1,
  "client/src/components/WorkflowSections.tsx::butler_event_feed": 2,
  "client/src/components/WorkflowSections.tsx::permission_prompt_tool": 1,
  "client/src/components/WorkflowSections.tsx::persistent_agent": 1,
  "client/src/components/WorkflowSections.tsx::plan_auto_continue": 2,
  "client/src/components/WorkflowSections.tsx::require_manual_approval": 2,
  "client/src/components/WorkflowSections.tsx::skip_preflight": 1,
  "client/src/hooks/useBoardPreferences.ts::board_card_aging_heatmap_${projectId}": 1,
  "client/src/hooks/useBoardPreferences.ts::board_recent_merges_collapsed_${projectId}": 1,
  "client/src/hooks/useBoardPreferences.ts::board_show_priority_legend_${projectId}": 1,
  "server/src/services/auth-rotation-ring.ts::cfg.rotationDisabledPrefKey": 1,
  "server/src/services/autodrive-stall-warning.service.ts::<row-value>": 1,
  "server/src/services/autodrive-stall-warning.service.ts::auto_merge_disabled_${row.projectId}": 1,
  "server/src/services/preference.service.ts::<row-value>": 1,
  "server/src/services/project.service.ts::export_skills_on_registration": 1,
  "server/src/services/start-policy.service.ts::board_autodrive_${projectId}": 1,
  "server/src/startup/ancestor-branch-reconciler.ts::<row-value>": 1,
  "server/src/startup/auto-merge-orchestrator.ts::<row-value>": 1,
  "server/src/startup/done-unmerged-invariant-scanner.ts::<row-value>": 1,
  "server/src/startup/exit-workflow.ts::<row-value>": 1,
  "server/src/startup/monitor-setup.ts::<row-value>": 2,
  "server/src/startup/plan-mode-reconciler.ts::<row-value>": 1,
  "server/src/startup/project-completion-reconciler.ts::markerKey": 1,
  "server/src/startup/stranded-review-reconciler.ts::<row-value>": 1,
  "server/src/startup/zombie-fix-session-reconciler.ts::<row-value>": 1,
};

/** String-typed settings whose legit VALUES include "true"/"false" — not polarity reads. */
const IGNORED_KEYS = new Set(["output_parser"]);
/** Non-preference sources that share the same syntactic shape. */
const LINE_SKIP = /c\.req\.query\(|localStorage|searchParams/;
const POLARITY = /(?:===|!==)\s*["'](?:true|false)["']/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...listTsFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function normalizeKey(raw: string): string {
  return raw.trim().replace(/^["'`]|["'`]$/g, "");
}

/** Extract the pref keys of every raw polarity read recognizable on this line. */
function scanLine(line: string): string[] {
  const keys: string[] = [];
  if (LINE_SKIP.test(line)) return keys;
  // prefMap.get("key") === "true" (any receiver, literal or dynamic key)
  for (const m of line.matchAll(/\.get\(\s*([^()]*?)\s*\)\s*(?:===|!==)\s*["'](?:true|false)["']/g)) keys.push(normalizeKey(m[1]!));
  // (await getPreference("key")) !== "false"
  if (line.includes("getPreference(") && POLARITY.test(line)) {
    const m = line.match(/getPreference\(\s*["']([\w.]+)["']/);
    keys.push(m ? m[1]! : "<getPreference>");
  }
  // settings.key === "true" / prefs.key / s.key (client Settings-record style)
  for (const m of line.matchAll(/\b(?:settings|prefs|s)\.([A-Za-z_]\w*)\s*\)?\s*(?:===|!==)\s*["'](?:true|false)["']/g)) keys.push(m[1]!);
  // settings[`dynamic_${id}`] === "true"
  for (const m of line.matchAll(/\b(?:settings|prefs|s)\[([^\]]+)\]\s*\)?\s*(?:===|!==)\s*["'](?:true|false)["']/g)) keys.push(normalizeKey(m[1]!));
  // row[0].value !== "false" / ([key, value]) => value === "true"
  for (const _m of line.matchAll(/\bvalue\s*(?:===|!==)\s*["'](?:true|false)["']/g)) keys.push("<row-value>");
  return keys.filter((k) => !IGNORED_KEYS.has(k));
}

function scanActual(): Map<string, { count: number; sites: string[] }> {
  const actual = new Map<string, { count: number; sites: string[] }>();
  for (const root of scanRoots) {
    for (const file of listTsFiles(root)) {
      const rel = path.relative(packagesRoot, file).replace(/\\/g, "/");
      const text = fs.readFileSync(file, "utf-8");
      for (const [i, line] of text.split(/\r?\n/).entries()) {
        for (const key of scanLine(line)) {
          const id = `${rel}::${key}`;
          const entry = actual.get(id) ?? { count: 0, sites: [] };
          entry.count += 1;
          entry.sites.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
          actual.set(id, entry);
        }
      }
    }
  }
  return actual;
}

describe("raw preference polarity reads are ratcheted (#947)", () => {
  const actual = scanActual();

  it("no NEW raw `=== \"true\"` / `!== \"false\"` preference reads beyond the baseline", () => {
    const offenders: string[] = [];
    for (const [id, { count, sites }] of actual) {
      const allowed = BASELINE[id] ?? 0;
      if (count > allowed) {
        offenders.push(`${id} (found ${count}, baseline ${allowed}):\n  ${sites.join("\n  ")}`);
      }
    }
    expect(
      offenders,
      `New raw polarity read(s). Read the key through getBool/parseBoolSetting ` +
        `(@agentic-kanban/shared/lib/settings-registry — honors the per-key registry default) ` +
        `or a canonical accessor (isAutoReviewEnabled/isAutoMergeEnabled) instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("baseline entries are not stale (ratchet down when a key is migrated)", () => {
    const stale: string[] = [];
    for (const [id, allowed] of Object.entries(BASELINE)) {
      const count = actual.get(id)?.count ?? 0;
      if (count < allowed) stale.push(`${id}: baseline ${allowed}, found ${count} — lower/remove the entry`);
    }
    expect(stale, `Stale baseline entries (nice work — tighten the ratchet):\n${stale.join("\n")}`).toEqual([]);
  });
});
