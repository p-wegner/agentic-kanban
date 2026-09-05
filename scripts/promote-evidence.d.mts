// Types for promote-evidence.mjs (#1045), so `promote-evidence.test.ts` can import the pure
// accumulated-gate-evidence summary without `tsc` falling back to `any` (TS7016).
//
// Hand-written, matching `promote-plan.d.mts` (#1014) and the `test-mine.d.mts` convention (#827).
// The test EXECUTES the real module, so a declaration for an export that no longer exists fails
// at import time, not only at type-check time.

export declare const OUTCOMES_RELPATH: string;
export declare const GATE_SOURCE: string;
export declare const SWEEP_SOURCE: string;

/** One row of `.test-impact/outcomes.jsonl`, as the skill's `writeOutcome` produces it. */
export interface OutcomeRow {
  at?: string | null;
  commit?: string | null;
  source?: string | null;
  result?: string | null;
  changed?: string[];
  selected?: string[];
  failed?: string[];
  missed?: string[];
  tier?: string | null;
  ran?: string | null;
  [key: string]: unknown;
}

export declare function parseOutcomeRows(text: string | null | undefined): OutcomeRow[];
export declare function isGateRow(row: OutcomeRow | null | undefined): boolean;
export declare function isSuspectRow(row: OutcomeRow | null | undefined): boolean;

export interface GateEvidenceSummary {
  ledgerPath: string | null;
  /** The window's lower bound, or null when no sweep timestamp was available. */
  since: string | null;
  totalRows: number;
  green: number;
  red: number;
  suspect: number;
  undated: number;
  sweepRows: number;
  files: string[];
  fileCount: number;
  firstAt: string | null;
  lastAt: string | null;
  /** Set by the driver when the ledger file could not be read at all. */
  unreadable?: string;
}

export declare function summarizeGateEvidence(
  rows: OutcomeRow[],
  opts?: { sinceIso?: string | null; ledgerPath?: string | null },
): GateEvidenceSummary;

/** What the driver produces when the ledger file itself could not be read. */
export interface UnreadableGateEvidence {
  ledgerPath: string | null;
  unreadable: string;
}

export declare function formatGateEvidence(
  summary: GateEvidenceSummary | UnreadableGateEvidence | null | undefined,
): string;
