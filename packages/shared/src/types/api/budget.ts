// Launch budget-estimate wire DTOs (#704). See ../api.ts barrel.

export interface BudgetEstimate {
  risk: BudgetRisk;
  estimatedTokens: number | null;
  avgTokensFromHistory: number | null;
  sessionCount: number;
  descriptionTokens: number;
  reason: string;
}

export type BudgetRisk = "low" | "medium" | "high";
