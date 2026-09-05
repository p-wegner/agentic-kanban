// Types for promote-plan.mjs (#1014), so `promote-plan.test.ts` can import the pure half of
// `pnpm promote` without `tsc` falling back to `any` (TS7016).
//
// Hand-written, matching `test-mine.d.mts` / `security-scan.d.mts` / `machine-verify-lock.d.mts`
// (#827). The script is deliberately plain `.mjs` with no build step: `scripts/promote.mjs` runs
// as bare `node` in a checkout that may hold nothing built at all — that is the situation it
// exists to fix — so a compile step between it and its own decision logic is one more thing that
// can disagree with itself.
//
// Drift is not silent: the test EXECUTES the real module, so a declaration for an export that no
// longer exists fails at import time, not only at type-check time.

export declare const DEFAULT_STABLE_CHECKOUT_DIRNAME: string;
export declare const PROMOTE_LOG_RELPATH: string;
export declare const DEFAULT_MAX_SWEEP_AGE_HOURS: number;
export declare const DEFAULT_BOARD_URL: string;
export declare const DEFAULT_PROJECT_NAME: string;

export declare function resolveStableCheckout(opts?: { env?: Record<string, string | undefined>; repoRoot?: string }): string;
export declare function resolveBoardUrl(env?: Record<string, string | undefined>): string;
export declare function resolveOperatedDbPath(opts?: { env?: Record<string, string | undefined>; homeDir?: string }): string;
export declare function resolveMaxSweepAgeMs(env?: Record<string, string | undefined>): number;
export declare function resolveProjectName(env?: Record<string, string | undefined>): string;

export declare function stableTagDate(date?: Date): string;

export interface ParsedStableTag {
  tag: string;
  date: string;
  ordinal: number;
}
export declare function parseStableTag(tag: string): ParsedStableTag | null;
export declare function nextStableTag(dateStamp: string, existingTags?: string[]): string;
export declare function sortStableTags(tags?: string[]): string[];
export declare function previousStableTag(existingTags?: string[], excludeTag?: string | null): string | null;

/** One `base_branch_health` row, in either the API's camelCase or sqlite's snake_case spelling. */
export interface SweepRow {
  sha?: string | null;
  branch?: string | null;
  outcome?: string | null;
  message?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
}

export interface SweepVerdict {
  /** True only for a fresh `green` verdict on the expected branch, carrying a sha. */
  ok: boolean;
  reason: string;
  detail: string;
  sha?: string | null;
  outcome?: string | null;
  at?: string | null;
  ageMs?: number;
  branch?: string | null;
  message?: string | null;
}
export declare function parseSweepVerdict(
  row: SweepRow | null | undefined,
  opts?: { branch?: string; nowMs?: number; maxAgeMs?: number },
): SweepVerdict;

export declare function shouldReinstall(lockBefore: string | null | undefined, lockAfter: string | null | undefined): boolean;

export interface PromotionStep {
  n: number;
  title: string;
  detail: string;
}
export interface PromotionPlanInput {
  sha: string;
  tag: string;
  previousTag: string | null;
  stableCheckout: string;
  repoRoot: string;
  boardUrl: string;
  dbPath: string;
  sweepSource: string;
  sweepVerdict: string;
  projectName: string;
  stablePort: number;
  dbUrl: string;
  logPath: string;
  forceSweep?: boolean;
}
export declare function buildPromotionPlan(input: PromotionPlanInput): PromotionStep[];
export declare function formatPlan(plan: PromotionStep[]): string;

export declare function shouldForceSmokeFailure(env?: Record<string, string | undefined>): boolean;

export interface PromoteDirection {
  ok: boolean;
  reason: "unknown" | "same" | "forward" | "behind";
  detail: string;
}
export declare function checkPromoteDirection(input: {
  stableHead: string | null | undefined;
  sha: string | null | undefined;
  shaIsDescendant: boolean;
}): PromoteDirection;
