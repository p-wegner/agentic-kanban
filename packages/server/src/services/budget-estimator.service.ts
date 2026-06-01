import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { issues, sessions, workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";

export type BudgetRisk = "low" | "medium" | "high";

export interface BudgetEstimate {
  risk: BudgetRisk;
  estimatedTokens: number | null;
  avgTokensFromHistory: number | null;
  sessionCount: number;
  descriptionTokens: number;
  reason: string;
}

// Rough token estimate: ~4 chars per token
function charsToTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

// Provider-specific context limits (in tokens)
const PROVIDER_CONTEXT_LIMITS: Record<string, number> = {
  claude: 180_000,
  codex: 100_000,
  copilot: 64_000,
};

// Risk thresholds as fractions of context limit
const RISK_THRESHOLDS = { medium: 0.25, high: 0.6 };

interface ParsedStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

function parseSessionStats(raw: string | null): ParsedStats | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    return {
      inputTokens: Number(p.inputTokens ?? 0),
      outputTokens: Number(p.outputTokens ?? 0),
      cacheReadTokens: Number(p.cacheReadTokens ?? 0),
    };
  } catch {
    return null;
  }
}

function totalTokensFor(s: ParsedStats): number {
  return s.inputTokens + s.outputTokens + s.cacheReadTokens;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export async function estimateBudget(
  database: Database,
  issueId: string,
  provider: string,
): Promise<BudgetEstimate> {
  const contextLimit = PROVIDER_CONTEXT_LIMITS[provider] ?? PROVIDER_CONTEXT_LIMITS.claude;

  // 1. Get issue description length
  const issueRows = await database
    .select({ description: issues.description, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const issue = issueRows[0];
  const descLen = (issue?.description ?? "").length;
  const descriptionTokens = charsToTokens(descLen);

  // 2. Look up recent completed sessions for the same project (exclude current issue's workspaces)
  let avgTokensFromHistory: number | null = null;
  let sessionCount = 0;

  if (issue?.projectId) {
    // Join workspaces through issues to filter by projectId (workspaces has no direct projectId column)
    const wsRows = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(
        and(
          eq(issues.projectId, issue.projectId),
          ne(workspaces.issueId, issueId),
        ),
      );

    if (wsRows.length > 0) {
      const wsIds = wsRows.map(w => w.id);
      const sessRows = await database
        .select({ stats: sessions.stats })
        .from(sessions)
        .where(inArray(sessions.workspaceId, wsIds))
        .orderBy(desc(sessions.startedAt))
        .limit(20);

      const validStats = sessRows
        .map(s => parseSessionStats(s.stats))
        .filter((s): s is ParsedStats => s !== null && totalTokensFor(s) > 0);

      sessionCount = validStats.length;
      if (sessionCount > 0) {
        const sum = validStats.reduce((acc, s) => acc + totalTokensFor(s), 0);
        avgTokensFromHistory = Math.round(sum / sessionCount);
      }
    }
  }

  // 3. Compute estimated tokens
  // If we have history: use avg + 10% buffer + description overhead
  // If no history: rough multiplier (description is ~10% of session total based on context overhead)
  const estimatedTokens = avgTokensFromHistory !== null
    ? Math.round(avgTokensFromHistory * 1.1 + descriptionTokens)
    : descriptionTokens > 0
      ? descriptionTokens * 10
      : null;

  // 4. Determine risk level
  let risk: BudgetRisk = "low";
  let reason: string;

  if (estimatedTokens !== null) {
    const fraction = estimatedTokens / contextLimit;
    if (fraction >= RISK_THRESHOLDS.high) {
      risk = "high";
      reason = `Estimated ~${formatTokens(estimatedTokens)} tokens may approach the ${formatTokens(contextLimit)} context limit`;
    } else if (fraction >= RISK_THRESHOLDS.medium) {
      risk = "medium";
      reason = `Estimated ~${formatTokens(estimatedTokens)} tokens — moderate session size expected`;
    } else {
      risk = "low";
      reason = sessionCount > 0
        ? `Based on ${sessionCount} similar session${sessionCount === 1 ? "" : "s"}, expected to fit comfortably`
        : "Short description — expected to fit within budget";
    }
  } else {
    risk = "low";
    reason = "No historical data — cannot estimate";
  }

  return {
    risk,
    estimatedTokens,
    avgTokensFromHistory,
    sessionCount,
    descriptionTokens,
    reason,
  };
}
