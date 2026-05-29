import { eq } from "drizzle-orm";
import { issues, sessionMessages, sessions, workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { detectConflicts, getDiff, getWorkingTreeDiff } from "./git.service.js";
import { getWorkspaceById, resolveProjectRepo } from "../repositories/workspace.repository.js";

export interface ScorecardDimension {
  name: string;
  score: number;
  maxScore: number;
  signal: string;
}

export interface ScorecardResult {
  total: number;
  dimensions: ScorecardDimension[];
  computedAt: string;
}

export async function computeScorecard(workspaceId: string, database: Database): Promise<ScorecardResult | null> {
  const ws = await getWorkspaceById(workspaceId, database);
  if (!ws || !ws.workingDir) return null;

  const issueRows = await database
    .select({ title: issues.title, description: issues.description })
    .from(issues)
    .where(eq(issues.id, ws.issueId))
    .limit(1);
  if (issueRows.length === 0) return null;
  const issue = issueRows[0];

  const { defaultBranch } = await resolveProjectRepo(workspaceId, database);
  const baseBranch = ws.baseBranch || defaultBranch;
  if (!ws.isDirect && !baseBranch) return null;

  let diff = "";
  let conflictResult = { hasConflicts: false, conflictingFiles: [] as string[] };
  try {
    diff = ws.isDirect ? await getWorkingTreeDiff(ws.workingDir) : await getDiff(ws.workingDir, baseBranch!);
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

  const dimensions: ScorecardDimension[] = [];

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
  dimensions.push({ name: "Tests", score: testsScore, maxScore: 25, signal: testSignal });

  const anyAdded = addedLines.filter((line) => /:\s*any\b|as\s+any\b|<any>/.test(line)).length;
  const typesScore = Math.max(0, 20 - anyAdded * 4);
  dimensions.push({
    name: "Types",
    score: typesScore,
    maxScore: 20,
    signal: anyAdded > 0 ? `${anyAdded} new \`any\` usage(s)` : "No new `any` usages",
  });

  const issueText = `${issue.title} ${issue.description ?? ""}`.toLowerCase();
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
  dimensions.push({ name: "Scope", score: scopeScore, maxScore: 15, signal: scopeSignal });

  let diffSizeScore: number;
  let diffSizeSignal: string;
  if (totalLoc === 0) {
    diffSizeScore = 8;
    diffSizeSignal = "No changes";
  } else if (totalLoc < 50) {
    diffSizeScore = 8;
    diffSizeSignal = `${totalLoc} LOC (small)`;
  } else if (totalLoc <= 500) {
    diffSizeScore = 10;
    diffSizeSignal = `${totalLoc} LOC (sweet spot)`;
  } else if (totalLoc <= 2000) {
    diffSizeScore = Math.round(10 - ((totalLoc - 500) / 1500) * 5);
    diffSizeSignal = `${totalLoc} LOC (large)`;
  } else {
    diffSizeScore = Math.max(0, Math.round(5 - ((totalLoc - 2000) / 1000)));
    diffSizeSignal = `${totalLoc} LOC (very large — consider splitting)`;
  }
  dimensions.push({ name: "Diff size", score: diffSizeScore, maxScore: 10, signal: diffSizeSignal });

  const conflictsScore = conflictResult.hasConflicts ? 0 : 10;
  const conflictsSignal = conflictResult.hasConflicts
    ? `${conflictResult.conflictingFiles.length} conflicting file(s)`
    : ws.isDirect
      ? "Direct workspace — no rebase check"
      : "Clean rebase on base branch";
  dimensions.push({ name: "Conflicts", score: conflictsScore, maxScore: 10, signal: conflictsSignal });

  const docSignals = changedFiles.filter((file) => file === "CLAUDE.md" || file === "README" || file === "README.md" || file.startsWith("docs/"));
  const isUserFacing = /\bui\b|user.facing|frontend|client|component|page|view|screen|button|modal|dialog/.test(issueText);
  let docsScore: number;
  let docsSignal: string;
  if (docSignals.length > 0) {
    docsScore = 10;
    docsSignal = `Docs updated: ${docSignals.join(", ")}`;
  } else if (isUserFacing && changedFiles.length > 0) {
    docsScore = 5;
    docsSignal = "User-facing change but no docs updated";
  } else {
    docsScore = 10;
    docsSignal = "No doc update required";
  }
  dimensions.push({ name: "Docs", score: docsScore, maxScore: 10, signal: docsSignal });

  let skillScore = 7;
  let skillSignal = "No code-review session found";
  try {
    const reviewSessions = await database
      .select({ id: sessions.id, exitCode: sessions.exitCode, triggerType: sessions.triggerType })
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId));
    const reviewSession = [...reviewSessions].reverse().find((session) => session.exitCode !== null && session.triggerType === "review")
      ?? [...reviewSessions].reverse().find((session) => session.exitCode !== null);
    if (reviewSession) {
      const msgRows = await database
        .select({ data: sessionMessages.data })
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, reviewSession.id));
      const reviewText = msgRows.map((msg) => msg.data ?? "").join(" ").toLowerCase();
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
  dimensions.push({ name: "Skill output", score: skillScore, maxScore: 10, signal: skillSignal });

  const total = dimensions.reduce((sum, dimension) => sum + dimension.score, 0);
  const computedAt = new Date().toISOString();

  await database.update(workspaces).set({
    scorecardScore: total,
    scorecardJson: JSON.stringify(dimensions),
    scorecardComputedAt: computedAt,
  }).where(eq(workspaces.id, workspaceId));

  return { total, dimensions, computedAt };
}

export async function getScorecardFromDb(workspaceId: string, database: Database): Promise<ScorecardResult | null> {
  const wsRows = await database
    .select({
      scorecardScore: workspaces.scorecardScore,
      scorecardJson: workspaces.scorecardJson,
      scorecardComputedAt: workspaces.scorecardComputedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (wsRows.length === 0) return null;

  const ws = wsRows[0];
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
