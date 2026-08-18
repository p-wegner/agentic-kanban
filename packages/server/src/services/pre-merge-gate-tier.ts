import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";

/**
 * The three verify-gate tiers (#538), replacing `verify_file_scope` plus the implicit
 * package/file scoping an operator could otherwise misalign as independent booleans:
 *  - `full`               — no scoping; every package's full suite runs (safest, slowest).
 *  - `scoped`              — package + file-level `vitest related` scoping (today's default
 *                            behavior of `verify_file_scope=true`), plus the always-run guard
 *                            suites (#278/#538) so tree-scanning invariants are never dropped.
 *  - `scoped-base-watch`   — `scoped`, PLUS a standing base-branch health signal (once one
 *                            exists) backstops the residual gap the always-run marker's static
 *                            classifier cannot see (a guard whose ambient read hides in a
 *                            helper). Falls back to `scoped` behavior until that base-health
 *                            mechanism lands — no knob may claim a proof it cannot yet make.
 *
 * A level may only WEAKEN verification VISIBLY: `buildGateTierMessage` always names the level
 * actually used, so a merge comment never hides which of these ran.
 */
export const VERIFY_GATE_STRATEGY_VALUES = ["full", "scoped", "scoped-base-watch"] as const;
export type VerifyGateStrategy = (typeof VERIFY_GATE_STRATEGY_VALUES)[number];

/** Default until a base-health signal exists (see `scoped-base-watch` above) — #538. */
export const DEFAULT_VERIFY_GATE_STRATEGY: VerifyGateStrategy = "full";

/** Preference key for a per-project override of the verify-gate strategy tier. */
// #496: built from the registry, so an unregistered prefix is a COMPILE error.
const verifyGateStrategyPrefDef = projectPref("verify_gate_strategy");

export function verifyGateStrategyPrefKey(projectId: string): string {
  return verifyGateStrategyPrefDef.key(projectId);
}

export async function resolveVerifyGateStrategy(projectId: string, database: Database): Promise<VerifyGateStrategy> {
  const raw = (await getPreference(verifyGateStrategyPrefKey(projectId), database).catch(() => null))?.trim().toLowerCase();
  return (VERIFY_GATE_STRATEGY_VALUES as readonly string[]).includes(raw ?? "")
    ? (raw as VerifyGateStrategy)
    : DEFAULT_VERIFY_GATE_STRATEGY;
}

/** Package `__tests__` dirs to scan for the `@gate:always-run` marker (#538), mirroring
 *  `scripts/test-mine.mjs`'s `ALWAYS_RUN_TESTS_DIR`. Best-effort: this repo checkout's own
 *  monorepo layout, so it is inert (returns 0) for a project this gate runs FOR that isn't
 *  this repo — the count only decorates the message, it never gates behavior. */
export const ALWAYS_RUN_TESTS_DIRS = [
  join("packages", "shared", "__tests__"),
  join("packages", "server", "src", "__tests__"),
  join("packages", "mcp-server", "src", "__tests__"),
  // #601: the client's suites were invisible to the always-run scan, so a
  // `@gate:always-run` marker in a client guard would have been silently ignored.
  join("packages", "client", "src", "__tests__"),
];

/** How many suites currently carry the `@gate:always-run` marker, purely for the gate
 *  message's "+N guard suites" figure — never throws, never affects gate behavior. */
export function countAlwaysRunGuardSuites(repoRoot: string): number {
  let count = 0;
  for (const dir of ALWAYS_RUN_TESTS_DIRS) {
    const abs = resolve(repoRoot, dir);
    if (!existsSync(abs)) continue;
    try {
      for (const name of readdirSync(abs)) {
        if (!name.endsWith(".test.ts")) continue;
        const text = readFileSync(join(abs, name), "utf8");
        if (text.includes("@gate:always-run")) count += 1;
      }
    } catch {
      // Best-effort decoration only — never let a scan error affect the gate.
    }
  }
  return count;
}

export interface GateTierInfo {
  strategy: VerifyGateStrategy;
  /** Whether `KANBAN_TEST_PACKAGES` was set at all — false for an unreadable diff, a
   *  global-config change, or a path owned by no package, in which case EVERY package's full
   *  suite ran regardless of `strategy`. Distinct from `fileScoped`: package-scoping without
   *  file-scoping is a real, narrower tier that must not be reported as "full". */
  packageScoped: boolean;
  fileScoped: boolean;
  changedFileCount: number;
  guardSuiteCount: number;
  maxWorkers: number;
}

/**
 * #538 — even a PASSED gate must say what actually ran, so a level may only weaken
 * verification VISIBLY: anyone reading a merge comment can see the tier, not just "passed".
 *
 * `tierInfo` is null whenever the verify_script branch never ran at all (smoke-only gate, or
 * docs-only skip handled by the caller before this is reached) — the message then names that
 * plainly instead of inventing tier details for a run that never happened.
 *
 * The tier label reflects what ACTUALLY ran, not the operator's `strategy` setting — a
 * `scoped` strategy with `verify_file_scope=false`, or an unreadable/unmodeled diff, performs
 * no narrowing at all and must say "full", never "package-scoped" (#538: a mislabeled tier is
 * exactly the "level weakens invisibly" failure this feature exists to prevent).
 */
export function buildGateTierMessage(tierInfo: GateTierInfo | null): string {
  if (!tierInfo) return "pre-merge gate passed (smoke check only — no verify_script tier)";
  const tier = tierInfo.fileScoped ? "file-scoped" : tierInfo.packageScoped ? "package-scoped" : "full";
  const parts = [
    `tier: ${tier}`,
    `${tierInfo.changedFileCount} changed file(s)`,
    ...(tierInfo.fileScoped ? [`+${tierInfo.guardSuiteCount} guard suites`] : []),
    `workers ${tierInfo.maxWorkers}`,
  ];
  return `pre-merge gate passed (${parts.join(", ")})`;
}
