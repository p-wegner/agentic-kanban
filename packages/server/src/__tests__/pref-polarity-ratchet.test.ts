// @gate:always-run — ratchets raw preference-polarity reads across the tree; imports nothing it checks (#538).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  walkPackageSources,
  parseGuardSource,
  forEachNode,
  lineOf,
  unwrapExpression,
  calleeName,
} from "../../../shared/__tests__/helpers/guard-scan.js";

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
 *
 * ## Why this is an AST pass and not a per-line regex (#779)
 *
 * It was a per-line regex until #779, and that is not a stylistic detail: the guard was
 * GREEN on a tree that contained exactly what it forbids. `plugin-loop.service.ts` held
 *
 *     const wasDone =
 *       (await getPreference(key, args.database)) === "true";
 *
 * for months. Split across two lines, neither line carries both `getPreference(` and the
 * `=== "true"`, so no line matched — until #727's decomposition reflowed the expression
 * onto ONE line and the "new" violation appeared. A guard whose green depends on where a
 * formatter chose to wrap has never been evidence of anything, and the evasion is
 * undeliberate: any developer whose editor wraps a long comparison gets an exemption
 * nobody chose.
 *
 * The fix is the #721 one — match the SHAPE on the TypeScript AST. A `BinaryExpression`
 * whose operator is `===`/`!==` and one of whose sides is the literal `"true"`/`"false"`
 * is the same node however it is printed, so line breaks, added parentheses and an
 * intervening `await` are all invisible to it. Two false-positive classes fall out for
 * free, because comments and string literals are not expressions: prose about the pattern
 * is no longer counted (the #617 defect, where documenting yourself raised a cap), and
 * neither is the shape written inside a string.
 *
 * NOT done by joining the file into one string and matching across newlines: that trades
 * this false negative for false positives spanning unrelated statements, and still cannot
 * tell a comparison from a comment.
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
  "server/src/services/project.service.ts::export_skills_on_registration": 1,
  // #779: three pre-existing reads the per-line REGEX could not see either — its key group
  // was `[^()]*?`, so a key built by a CALL (`get(autodrivePrefKey(id))`) never matched. The
  // AST pass reads the argument whatever its shape, so they surface for the first time here.
  // Grandfathered, not fixed: production source is not #779's to touch. Each is a per-project
  // dynamic key with an intentional default-OFF, the same class as the `${projectId}` entries
  // above.
  "server/src/services/project-runtime-config.service.ts::autoMergeDisabledPrefKey(input.projectId)": 1,
  "server/src/services/project-runtime-config.service.ts::autodrivePrefKey(input.projectId)": 1,
  "server/src/services/project-runtime-config.service.ts::harnessSettingKey(harness, \"plan_auto_continue\")": 1,
  "server/src/services/start-policy.service.ts::board_autodrive_${projectId}": 1,
  "server/src/startup/ancestor-branch-reconciler.ts::<row-value>": 1,
  "server/src/startup/auto-merge-orchestrator.ts::<row-value>": 1,
  // The canonical plugin-enablement accessor (isPluginEnabledForProject). Baselined for the
  // same reason isAutoReviewEnabled/isAutoMergeEnabled are: a canonical accessor is the ONE
  // sanctioned home for a key's polarity. This entry must stay at 1 — a second raw read of
  // plugin_enabled_* anywhere is the violation this ratchet exists to catch.
  "server/src/repositories/plugins.repository.ts::<row-value>": 1,
  "server/src/startup/done-unmerged-invariant-sweep.ts::<row-value>": 1,
  "server/src/startup/exit-workflow.ts::<row-value>": 1,
  "server/src/startup/monitor-setup.ts::<row-value>": 2,
  // Both reconcilers now read their toggle through a NAMED constant rather than an inline
  // row value, so the ratchet id moved from `<row-value>` to the constant. Same single read
  // in each (a tri-state default-on check: absent pref means enabled), not a new violation.
  "server/src/startup/plan-mode-reconciler.ts::PREF_RECONCILER_STRANDED_PLAN_ENABLED": 1,
  "server/src/startup/project-completion-reconciler.ts::markerKey": 1,
  "server/src/startup/stranded-review-reconciler.ts::PREF_RECONCILER_STRANDED_REVIEW_ENABLED": 1,
  "server/src/startup/zombie-fix-session-reconciler.ts::<row-value>": 1,
};

/** String-typed settings whose legit VALUES include "true"/"false" — not polarity reads. */
const IGNORED_KEYS = new Set(["output_parser"]);
/**
 * Non-preference sources that share the same syntactic shape. Tested against the TEXT of
 * the COMPARISON's own subtree rather than the whole line: the per-line version excused
 * every read that merely happened to share a line with a `searchParams` mention.
 */
const NON_PREF_SOURCE = /c\.req\.query\(|localStorage|searchParams/;
/** Receivers whose property reads are a client Settings record, not an arbitrary object. */
const SETTINGS_RECEIVERS = new Set(["settings", "prefs", "s"]);

function normalizeKey(raw: string): string {
  return raw.trim().replace(/^["'`]|["'`]$/g, "");
}

/** `"true"` / `"false"` written as a literal — the polarity half of the comparison. */
function isPolarityLiteral(expr: ts.Expression): boolean {
  const node = unwrapExpression(expr);
  return ts.isStringLiteralLike(node) && (node.text === "true" || node.text === "false");
}

/**
 * The preference key that the non-literal side of the comparison reads, or `null` when
 * that side is not a recognizable preference read. The recognized shapes are the ones the
 * per-line version had, one node kind each:
 *
 *   - `prefMap.get(<key>)`            — any receiver, literal or dynamic key
 *   - `getPreference("key", …)`       — a dynamic key degrades to `<getPreference>`
 *   - `settings.key` / `prefs[expr]`  — the client Settings-record style
 *   - `row.value` / a bare `value`    — a DB row whose key is dynamic
 */
function preferenceKeyOf(expr: ts.Expression, sf: ts.SourceFile): string | null {
  const node = unwrapExpression(expr);
  // `(settings["harness.codex.plan_auto_continue"] ?? settings.plan_auto_continue) !== "false"`:
  // a coalesced read is ONE polarity decision with a primary key and a fallback, so it counts
  // once, under the key whose default the polarity actually expresses — the LAST operand.
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      return preferenceKeyOf(node.right, sf) ?? preferenceKeyOf(node.left, sf);
    }
    return null;
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    const first = node.arguments[0];
    if (name === "get") return first ? normalizeKey(first.getText(sf)) : null;
    if (name === "getPreference") {
      if (first && ts.isStringLiteralLike(first)) return first.text;
      return "<getPreference>";
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === "value") return "<row-value>";
    const receiver = unwrapExpression(node.expression);
    if (ts.isIdentifier(receiver) && SETTINGS_RECEIVERS.has(receiver.text)) return node.name.text;
    return null;
  }
  if (ts.isElementAccessExpression(node)) {
    const receiver = unwrapExpression(node.expression);
    if (ts.isIdentifier(receiver) && SETTINGS_RECEIVERS.has(receiver.text)) {
      return normalizeKey(node.argumentExpression.getText(sf));
    }
    return null;
  }
  // `([key, value]) => value === "true"` — the key is dynamic, the shape is still a read.
  if (ts.isIdentifier(node) && node.text === "value") return "<row-value>";
  return null;
}

export interface PolarityHit {
  key: string;
  line: number;
  text: string;
}

/**
 * Every raw polarity read in one source text. Kept as a named function taking the text so
 * the #779 proof cases below can run the REAL scanner over a synthetic source instead of
 * asserting things about a regex — a proof against a copy proves nothing.
 */
export function scanPolaritySource(cacheKey: string, text: string): PolarityHit[] {
  const sf = parseGuardSource(cacheKey, text);
  const hits: PolarityHit[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isBinaryExpression(node)) return;
    const op = node.operatorToken.kind;
    if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return;
    const readSide = isPolarityLiteral(node.right) ? node.left : isPolarityLiteral(node.left) ? node.right : null;
    if (!readSide) return;
    const subtree = node.getText(sf);
    if (NON_PREF_SOURCE.test(subtree)) return;
    const key = preferenceKeyOf(readSide, sf);
    if (key === null || IGNORED_KEYS.has(key)) return;
    hits.push({ key, line: lineOf(sf, node), text: subtree.replace(/\s+/g, " ").slice(0, 160) });
  });
  return hits;
}

function scanActual(): Map<string, { count: number; sites: string[] }> {
  const actual = new Map<string, { count: number; sites: string[] }>();
  for (const root of scanRoots) {
    for (const file of walkPackageSources(root)) {
      const rel = path.relative(packagesRoot, file).replace(/\\/g, "/");
      for (const hit of scanPolaritySource(file, fs.readFileSync(file, "utf-8"))) {
        const id = `${rel}::${hit.key}`;
        const entry = actual.get(id) ?? { count: 0, sites: [] };
        entry.count += 1;
        entry.sites.push(`${rel}:${hit.line}: ${hit.text}`);
        actual.set(id, entry);
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

/**
 * #779's proof obligation: a conversion is worth nothing unless it is shown to catch the
 * form the old guard could not see. These drive the REAL {@link scanPolaritySource} — the
 * same function the tree scan above uses — so a regression in the scanner fails here
 * rather than silently re-opening the exemption.
 */
describe("the polarity scan sees forms the per-line version could not (#779)", () => {
  const scan = (name: string, lines: string[]): PolarityHit[] =>
    scanPolaritySource(`/virtual/pref-polarity/${name}.ts`, lines.join("\n"));

  it("catches the exact wrapped read that hid in plugin-loop.service.ts for months", () => {
    // The pre-#727 shape: `getPreference(` and the `=== "true"` are on DIFFERENT lines, so
    // no single line carried both and the old per-line regex saw nothing at all.
    const hits = scan("wrapped-get-preference", [
      "async function f(key: string, args: { database: unknown }) {",
      "  const wasDone =",
      '    (await getPreference(key, args.database)) === "true";',
      "  return wasDone;",
      "}",
    ]);
    expect(hits.map((h) => h.key)).toEqual(["<getPreference>"]);
  });

  it("catches a wrapped prefMap.get() read, literal key intact across the break", () => {
    const hits = scan("wrapped-map-get", ["const on =", '  prefs.get("auto_monitor")', '    === "true";']);
    expect(hits.map((h) => h.key)).toEqual(["auto_monitor"]);
  });

  it("catches a wrapped settings-record read with the polarity literal on the LEFT", () => {
    const hits = scan("literal-left", ['const on = "true"', "  === settings.persistent_agent;"]);
    expect(hits.map((h) => h.key)).toEqual(["persistent_agent"]);
  });

  it("does not count PROSE about the pattern, which the text scan did", () => {
    // The #617 defect in this same shape: a comment explaining the convention read as an
    // instance of it, so documenting yourself pushed the ratchet up.
    const hits = scan("prose", [
      '// Never write `getPreference("auto_monitor") === "true"` — use getBool instead.',
      '/* settings.persistent_agent === "true" is the shape this ratchet forbids. */',
      "const message = 'getPreference(\"x\") === \"true\"';",
      "export const noop = () => message;",
    ]);
    expect(hits).toEqual([]);
  });

  it("still excuses a non-preference source, and now only within the comparison itself", () => {
    const excused = scan("non-pref", ['const raw = c.req.query("flag") === "true";']);
    expect(excused).toEqual([]);
    // …but a real read no longer rides along just because a neighbour on the same line
    // mentioned searchParams, which is what the LINE_SKIP regex used to grant.
    const caught = scan("non-pref-neighbour", [
      'const q = new URLSearchParams(location.search).get("x");',
      'const on = prefs.get("auto_monitor") === "true";',
    ]);
    expect(caught.map((h) => h.key)).toEqual(["auto_monitor"]);
  });
});
