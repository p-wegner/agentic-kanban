// Types for rc-state.mjs (#1238), so `rc-state.test.ts` can import the release-candidate
// lifecycle module without `tsc` falling back to `any` (TS7016).
//
// Hand-written, matching `promote-plan.d.mts` / `promote-evidence.d.mts`. The test EXECUTES the
// real module, so a declaration for an export that no longer exists fails at import time.

export declare const RC_STATE_RELPATH: string;
export declare const RC_BRANCH_PREFIX: string;
export declare const RC_STATES: readonly RcState[];
export declare const TERMINAL_RC_STATES: readonly RcState[];
export declare const DEFAULT_RC_CADENCE_MS: number;

export type RcState = "cut" | "sweeping" | "red" | "healing" | "green" | "promoted" | "abandoned";

export interface RcCandidate {
  branch: string;
  sha: string | null;
  state: RcState;
  cutAt: string | null;
  updatedAt: string | null;
  tag: string | null;
  failedSuites: string[];
  note: string | null;
}

export interface RcStateFile {
  version: 1;
  candidates: RcCandidate[];
}

export interface ParsedRcBranch {
  branch: string;
  date: string;
  ordinal: number;
}

export interface RcCandidatePlan {
  action: "reuse" | "cut";
  branch: string;
  abandon: string | null;
  reason: string;
}

export declare function isTerminalRcState(state: string | null | undefined): boolean;
export declare function parseRcBranch(branch: string | null | undefined): ParsedRcBranch | null;
export declare function nextRcBranch(dateStamp: string, existingBranches?: string[]): string;
export declare function sortRcBranches(branches?: string[]): string[];
export declare function emptyRcState(): RcStateFile;
export declare function parseRcState(text: string | null | undefined): RcStateFile;
export declare function serializeRcState(state: RcStateFile): string;
export declare function findRcCandidate(state: RcStateFile, branch: string): RcCandidate | null;
export declare function currentRcCandidate(state: RcStateFile): RcCandidate | null;
export declare function upsertRcCandidate(
  state: RcStateFile,
  branch: string,
  patch: Partial<RcCandidate>,
  atIso?: string,
): RcStateFile;
export declare function planRcCandidate(opts: {
  dateStamp: string;
  state: RcStateFile;
  existingBranches?: string[];
  nowMs?: number;
  cadenceMs?: number;
}): RcCandidatePlan;
export declare function rcStatePath(stableCheckout: string): string;
export declare function readRcState(stableCheckout: string): RcStateFile;
export declare function writeRcState(stableCheckout: string, state: RcStateFile): string;
export declare function formatRcCandidate(candidate: RcCandidate | null | undefined): string;
