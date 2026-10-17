// Types for promote-ci.mjs (#1562), so `promote-ci.test.ts` can import it without TS7016.
// Hand-written, matching `promote-evidence.d.mts`.

export declare const CI_RUN_FIELDS: string;

export interface CiRun {
  databaseId?: number;
  workflowName?: string;
  status?: string;
  conclusion?: string | null;
  headSha?: string;
  url?: string;
  createdAt?: string;
  event?: string;
}

export interface PromoteCiVerdict {
  ok: boolean;
  red: Array<{ workflow: string; url: string }>;
  pending: string[];
  green: string[];
  detail: string;
}

export declare function parseRequiredWorkflows(raw: string | null | undefined): string[];
export declare function evaluatePromoteCi(runs: CiRun[] | null | undefined, required?: string[]): PromoteCiVerdict;
export declare function formatCiRefusal(verdict: PromoteCiVerdict, sha: string): string;
export declare function readCiForSha(
  sha: string,
  opts?: { cwd?: string; exec?: (...args: unknown[]) => unknown },
): { available: true; runs: CiRun[] } | { available: false; reason: string };
