import type { Database } from "../db/index.js";
import { detectConflicts, getDiff } from "./git.service.js";
import { getWorkspaceById, resolveProjectRepo } from "../repositories/workspace.repository.js";
import { getSessionMessageRows } from "../repositories/session.repository.js";
import { resolveDiffRef } from "@agentic-kanban/shared/lib/git-service";
import type { ScorecardDimension, ScorecardResult } from "@agentic-kanban/shared/types";
import {
  getScorecardIssue,
  getScorecardReviewSessions,
  persistScorecard,
  getScorecardColumns,
} from "../repositories/workspace-scorecard.repository.js";

// Shapes live in shared (#569) — WorkspaceCard.tsx had its own copy.
export type { ScorecardDimension, ScorecardResult };

function scoreTests(changedFiles: string[]): ScorecardDimension {
  const testFileRe = /\.(test|spec)\.[jt]sx?$|__tests__\//i;
  const sourceFileRe = /\.[jt]sx?$/;
  const testFilesChanged = changedFiles.filter((file) => testFileRe.test(file));
  const sourceFilesChanged = changedFiles.filter((file) => sourceFileRe.test(file) && !testFileRe.test(file));
  let testsScore = 25;
  if (sourceFilesChanged.length > 0 && testFilesChanged.length === 0) {
    testsScore = 10;
  } else if (changedFiles.length === 0) {
    testsScore = 20;
  }
  const testSignal = testFilesChanged.length > 0
    ? `${testFilesChanged.length} test file(s) modified`
    : sourceFilesChanged.length > 0
      ? `${sourceFilesChanged.length} source file(s) changed, no test files`
      : "No file changes detected";
  return { name: "Tests", score: testsScore, maxScore: 25, signal: testSignal };
}

function scoreTypes(addedLines: string[]): ScorecardDimension {
  const anyAdded = addedLines.filter((line) => /:\s*any\b|as\s+any\b|<any>/.test(line)).length;
  return {
    name: "Types",
    score: Math.max(0, 20 - anyAdded * 4),
    maxScore: 20,
    signal: anyAdded > 0 ? `${anyAdded} new \`any\` usage(s)` : "No new `any` usages",
  };
}

function scoreScope(changedFiles: string[], issueText: string): ScorecardDimension {
  const keywords = issueText.match(/\b[a-z][a-z0-9]{2,}\b/g) ?? [];
  const ignoredKeywords = new Set(["this", "that", "with", "from", "have", "been", "will", "into", "your", "more", "some", "they"]);
  const uniqueKeywords = [...new Set(keywords.filter((keyword) => keyword.length > 3 && !ignoredKeywords.has(keyword)))].slice(0, 20);
  const matchedFiles = changedFiles.filter((file) => uniqueKeywords.some((keyword) => file.toLowerCase().includes(keyword)));
  let scopeScore = 15;
  let scopeSignal = "No changed files to evaluate";
  if (changedFiles.length > 0) {
    const matchRatio = uniqueKeywords.length > 0 ? matchedFiles.length / changedFiles.length : 0.5;
    scopeScore = Math.max(5, Math.round(matchRatio * 15));
    scopeSignal = uniqueKeywords.length > 0
      ? `${matchedFiles.length}/${changedFiles.length} files match ticket keywords`
      : "No keywords extracted from ticket";
  }
  return { name: "Scope", score: scopeScore, maxScore: 15, signal: scopeSignal };
}

function scoreDiffSize(totalLoc: number): ScorecardDimension {
  let score: number;
  let signal: string;
  if (totalLoc === 0) {
    score = 8;
    signal = "No changes";
  } else if (totalLoc < 50) {
    score = 8;
    signal = `${totalLoc} LOC (small)`;
  } else if (totalLoc <= 500) {
    score = 10;
    signal = `${totalLoc} LOC (sweet spot)`;
  } else if (totalLoc <= 2000) {
    score = Math.round(10 - ((totalLoc - 500) / 1500) * 5);
    signal = `${totalLoc} LOC (large)`;
  } else {
    score = Math.max(0, Math.round(5 - ((totalLoc - 2000) / 1000)));
    signal = `${totalLoc} LOC (very large — consider splitting)`;
  }
  return { name: "Diff size", score, maxScore: 10, signal };
}

function scoreConflicts(
  conflictResult: { hasConflicts: boolean; conflictingFiles: string[] },
  isDirect: boolean | null | undefined,
): ScorecardDimension {
  const signal = conflictResult.hasConflicts
    ? `${conflictResult.conflictingFiles.length} conflicting file(s)`
    : isDirect
      ? "Direct workspace — no rebase check"
      : "Clean rebase on base branch";
  return { name: "Conflicts", score: conflictResult.hasConflicts ? 0 : 10, maxScore: 10, signal };
}

function scoreDocs(changedFiles: string[], issueText: string): ScorecardDimension {
  const docSignals = changedFiles.filter((file) => file === "CLAUDE.md" || file === "README" || file === "README.md" || file.startsWith("docs/"));
  const isUserFacing = /\bui\b|user.facing|frontend|client|component|page|view|screen|button|modal|dialog/.test(issueText);
  let score: number;
  let signal: string;
  if (docSignals.length > 0) {
    score = 10;
    signal = `Docs updated: ${docSignals.join(", ")}`;
  } else if (isUserFacing && changedFiles.length > 0) {
    score = 5;
    signal = "User-facing change but no docs updated";
  } else {
    score = 10;
    signal = "No doc update required";
  }
  return { name: "Docs", score, maxScore: 10, signal };
}

async function scoreSkillOutput(workspaceId: string, database: Database): Promise<ScorecardDimension> {
  let skillScore = 7;
  let skillSignal = "No code-review session found";
  try {
    const reviewSessions = await getScorecardReviewSessions(workspaceId, database);
    const reviewSession = [...reviewSessions].reverse().find((session) => session.exitCode !== null && session.triggerType === "review")
      ?? [...reviewSessions].reverse().find((session) => session.exitCode !== null);
    if (reviewSession) {
      const msgRows = await getSessionMessageRows(reviewSession.id, database);
      const reviewText = msgRows.map((row) => row.data ?? "").join(" ").toLowerCase();
      const criticalIssues = (reviewText.match(/\bcritical\b|\bmajor issue\b|\bsecurity\b|\bbreaking\b/g) ?? []).length;
      if (criticalIssues === 0) {
        skillScore = 10;
        skillSignal = "Code review: no critical issues found";
      } else {
        skillScore = Math.max(0, 10 - criticalIssues * 2);
        skillSignal = `Code review: ${criticalIssues} critical/major issue(s)`;
      }
    }
  } catch {
    // Ignore review parsing issues and keep neutral score.
  }
  return { name: "Skill output", score: skillScore, maxScore: 10, signal: skillSignal };
}

export async function computeScorecard(workspaceId: string, database: Database): Promise<ScorecardResult | null> {
  const ws = await getWorkspaceById(workspaceId, database);
  if (!ws || !ws.workingDir) return null;

  const issue = await getScorecardIssue(ws.issueId, database);
  if (!issue) return null;

  const { defaultBranch } = await resolveProjectRepo(workspaceId, database);
  const baseBranch = ws.baseBranch || defaultBranch;
  if (!ws.isDirect && !baseBranch) return null;
  const diffRef = resolveDiffRef(ws, defaultBranch);
  if (!diffRef) return null;

  let diff = "";
  let conflictResult = { hasConflicts: false, conflictingFiles: [] as string[] };
  try {
    // #530: one call. getDiff honours the "HEAD" sentinel now (it did not when this
    // branch was written — that was the bug behind the sentinel being ignored), and for
    // that ref it does exactly what getWorkingTreeDiff does: `git diff HEAD` plus the
    // untracked entries. Conflict detection stays gated: a direct workspace has no base
    // to conflict against.
    diff = await getDiff(ws.workingDir, diffRef);
    if (!ws.isDirect) {
      conflictResult = await detectConflicts(ws.workingDir, baseBranch!);
    }
  } catch {
    // Best effort — leave diff/conflicts empty when git data is unavailable.
  }

  const lines = diff.split("\n");
  const addedLines = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removedLines = lines.filter((line) => line.startsWith("-") && !line.startsWith("---"));
  const totalLoc = addedLines.length + removedLines.length;

  const changedFiles = [...new Set(lines.flatMap((line) => {
    const match = line.match(/^diff --git a\/(.+) b\//);
    return match ? [match[1]] : [];
  }))];

  const issueText = `${issue.title} ${issue.description ?? ""}`.toLowerCase();
  const dimensions: ScorecardDimension[] = [
    scoreTests(changedFiles),
    scoreTypes(addedLines),
    scoreScope(changedFiles, issueText),
    scoreDiffSize(totalLoc),
    scoreConflicts(conflictResult, ws.isDirect),
    scoreDocs(changedFiles, issueText),
    await scoreSkillOutput(workspaceId, database),
  ];

  const total = dimensions.reduce((sum, dimension) => sum + dimension.score, 0);
  const computedAt = new Date().toISOString();

  await persistScorecard(workspaceId, {
    scorecardScore: total,
    scorecardJson: JSON.stringify(dimensions),
    scorecardComputedAt: computedAt,
  }, database);

  return { total, dimensions, computedAt };
}

export async function getScorecardFromDb(workspaceId: string, database: Database): Promise<ScorecardResult | null> {
  const ws = await getScorecardColumns(workspaceId, database);
  if (!ws) return null;
  if (ws.scorecardScore === null || !ws.scorecardJson) return null;

  try {
    return {
      total: ws.scorecardScore,
      dimensions: JSON.parse(ws.scorecardJson) as ScorecardDimension[],
      computedAt: ws.scorecardComputedAt ?? "",
    };
  } catch {
    return null;
  }
}
