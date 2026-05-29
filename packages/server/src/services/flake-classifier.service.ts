import { randomUUID } from "node:crypto";
import { eq, desc, inArray } from "drizzle-orm";
import { flakyTests, testRetryDecisions, projects, workspaces as workspacesTable, issues } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";

export type FlakeDecision = "flake" | "suspicious" | "real";
export type FinalOutcome = "confirmed_flake" | "confirmed_real" | "pending";

export interface ClassifierInput {
  testName: string;
  errorMessage?: string;
  stackTrace?: string;
  /** Files changed in the current workspace diff (relative paths). */
  changedFiles?: string[];
  /** Path to the test file (e.g. "packages/e2e/tests/ui/board.test.ts"). */
  testFilePath?: string;
  projectId: string;
  sessionId: string;
  workspaceId: string;
}

export interface ClassifierResult {
  decision: FlakeDecision;
  /** Confidence score [0, 1]. */
  confidence: number;
  reasoning: string;
  /** Id of the matching flaky-test registry entry, if any. */
  matchedFlakyTestId?: string;
  /** Whether the changed files appear to touch the subject of this test. */
  changesOverlapWithSubject: boolean;
}

export interface CreateFlakyTestRequest {
  projectId: string;
  testName: string;
  testFilePath?: string;
  errorPattern?: string;
  reason?: string;
}

export interface FlakyTestResponse {
  id: string;
  projectId: string;
  testName: string;
  testFilePath: string | null;
  errorPattern: string | null;
  reason: string | null;
  createdAt: string;
}

export interface RetryDecisionResponse {
  id: string;
  sessionId: string;
  workspaceId: string;
  testName: string;
  decision: FlakeDecision;
  confidence: number;
  retryCount: number;
  finalOutcome: FinalOutcome;
  reasoning: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FalseFlakeTelemetry {
  total: number;
  confirmedReal: number;
  confirmedFlake: number;
  pending: number;
  /** Rate of "retried as flake but was actually real" (false-flake rate). */
  falseFlakeRate: number;
}

/**
 * Determine whether any of the changed files overlap with the subject tested
 * by this test. Uses a simple path-based heuristic:
 * - If the testFilePath is provided, compute the "subject" as the same
 *   directory minus common test suffixes (e.g. board.test.ts → board).
 * - A changedFile "overlaps" if it shares a path segment with the subject name,
 *   or if it is the test file itself.
 */
function computeOverlap(
  testFilePath: string | undefined | null,
  changedFiles: string[],
): boolean {
  if (!testFilePath || changedFiles.length === 0) return false;

  // Normalise separators
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const normTest = norm(testFilePath);

  // The test file itself changed — definitely overlaps
  if (changedFiles.some(f => norm(f) === normTest || normTest.endsWith(norm(f)))) {
    return true;
  }

  // Extract subject name from the test file path (strip .test.ts, .spec.ts etc.)
  const testBasename = normTest.split("/").pop() ?? "";
  const subjectName = testBasename.replace(/\.(test|spec)\.[jt]sx?$/, "");

  if (!subjectName) return false;

  // Any changed file whose name contains the subject name overlaps
  return changedFiles.some(f => {
    const base = norm(f).split("/").pop() ?? "";
    return base.includes(subjectName) || norm(f).includes(`/${subjectName}`);
  });
}

export function createFlakeClassifierService(database: Database) {

  // ─── Flaky Test Registry CRUD ─────────────────────────────────────────────

  async function listFlakyTests(projectId: string): Promise<FlakyTestResponse[]> {
    return database
      .select()
      .from(flakyTests)
      .where(eq(flakyTests.projectId, projectId))
      .orderBy(flakyTests.createdAt);
  }

  async function createFlakyTest(req: CreateFlakyTestRequest): Promise<FlakyTestResponse> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await database.insert(flakyTests).values({
      id,
      projectId: req.projectId,
      testName: req.testName,
      testFilePath: req.testFilePath ?? null,
      errorPattern: req.errorPattern ?? null,
      reason: req.reason ?? null,
      createdAt: now,
    });
    const [row] = await database.select().from(flakyTests).where(eq(flakyTests.id, id));
    return row;
  }

  async function deleteFlakyTest(id: string): Promise<void> {
    await database.delete(flakyTests).where(eq(flakyTests.id, id));
  }

  // ─── Classifier ───────────────────────────────────────────────────────────

  /**
   * Classify a test failure and persist the decision.
   * Returns the classifier result and the id of the persisted decision record.
   */
  async function classifyFailure(input: ClassifierInput): Promise<ClassifierResult & { decisionId: string }> {
    // Load project retry settings
    const [project] = await database
      .select({ autoRetryFlakes: projects.autoRetryFlakes, maxRetries: projects.maxRetries })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);

    // Load all known flaky tests for this project
    const knownFlaky = await database
      .select()
      .from(flakyTests)
      .where(eq(flakyTests.projectId, input.projectId));

    type FlakyTestRow = { id: string; testName: string; testFilePath: string | null; errorPattern: string | null; reason: string | null };

    // Find a matching entry
    const match = (knownFlaky as FlakyTestRow[]).find(ft => {
      // Match by test name (substring)
      const nameMatch = input.testName.toLowerCase().includes(ft.testName.toLowerCase()) ||
                        ft.testName.toLowerCase().includes(input.testName.toLowerCase());
      if (!nameMatch) return false;

      // Optionally match by error pattern (regex)
      if (ft.errorPattern && input.errorMessage) {
        try {
          return new RegExp(ft.errorPattern, "i").test(input.errorMessage);
        } catch {
          return false;
        }
      }
      return nameMatch;
    });

    const changesOverlapWithSubject = computeOverlap(
      match?.testFilePath ?? input.testFilePath,
      input.changedFiles ?? [],
    );

    let decision: FlakeDecision;
    let confidence: number;
    let reasoning: string;

    if (!match) {
      // Not in the flaky radar → treat as real failure
      decision = "real";
      confidence = 0.95;
      reasoning = `Test "${input.testName}" is not in the flaky-test registry — treating as a real failure.`;
    } else if (!changesOverlapWithSubject) {
      // Known flaky AND changed files don't touch its subject → very likely a flake
      decision = "flake";
      confidence = 0.82;
      reasoning = `Test "${input.testName}" is in the flaky-test registry and the workspace diff does not touch its subject files — auto-retrying as a suspected flake. Reason: ${match.reason ?? "n/a"}.`;
    } else {
      // Known flaky BUT changed files overlap with subject → suspicious
      decision = "suspicious";
      confidence = 0.55;
      reasoning = `Test "${input.testName}" is in the flaky-test registry but the workspace diff touches its subject files — retrying once and escalating if still red. Reason: ${match.reason ?? "n/a"}.`;
    }

    // Persist the decision
    const decisionId = randomUUID();
    const now = new Date().toISOString();
    await database.insert(testRetryDecisions).values({
      id: decisionId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      testName: input.testName,
      decision,
      confidence,
      retryCount: 0,
      finalOutcome: "pending",
      classifierInput: JSON.stringify({
        testName: input.testName,
        errorMessage: input.errorMessage,
        changedFiles: input.changedFiles,
        testFilePath: input.testFilePath,
        projectId: input.projectId,
      }),
      reasoning,
      createdAt: now,
      updatedAt: now,
    });

    return { decision, confidence, reasoning, matchedFlakyTestId: match?.id, changesOverlapWithSubject, decisionId };
  }

  /**
   * Record a retry outcome:
   * - passed = the test passed on retry → it was indeed a flake ("confirmed_real" means non-det behaviour confirmed)
   * - failed = still failed → escalate (confirmed_real regression or exhausted retries on actual flake)
   */
  async function recordRetryOutcome(
    decisionId: string,
    outcome: "passed" | "failed",
    retryCount: number,
    maxRetries: number,
  ): Promise<RetryDecisionResponse> {
    const now = new Date().toISOString();
    let finalOutcome: FinalOutcome = "pending";

    if (outcome === "passed") {
      // Passed on retry → confirmed it was a non-deterministic (flake) failure
      finalOutcome = "confirmed_real";
    } else if (retryCount >= maxRetries) {
      // Exhausted retries and still failing → confirmed regression
      finalOutcome = "confirmed_flake";
    }

    await database.update(testRetryDecisions)
      .set({ retryCount, finalOutcome, updatedAt: now })
      .where(eq(testRetryDecisions.id, decisionId));

    const [updated] = await database.select().from(testRetryDecisions).where(eq(testRetryDecisions.id, decisionId));
    return updated as RetryDecisionResponse;
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  async function getDecisionsForSession(sessionId: string): Promise<RetryDecisionResponse[]> {
    return database
      .select()
      .from(testRetryDecisions)
      .where(eq(testRetryDecisions.sessionId, sessionId))
      .orderBy(desc(testRetryDecisions.createdAt)) as Promise<RetryDecisionResponse[]>;
  }

  async function getDecisionsForWorkspace(workspaceId: string): Promise<RetryDecisionResponse[]> {
    return database
      .select()
      .from(testRetryDecisions)
      .where(eq(testRetryDecisions.workspaceId, workspaceId))
      .orderBy(desc(testRetryDecisions.createdAt)) as Promise<RetryDecisionResponse[]>;
  }

  /**
   * Compute false-flake telemetry for a project:
   * - false-flake rate = decisions where we classified as flake/suspicious but the
   *   final outcome was "confirmed_flake" (i.e. retries exhausted, still failing = real regression)
   */
  async function getTelemetry(projectId: string): Promise<FalseFlakeTelemetry> {
    const wsRows = await database
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .innerJoin(issues, eq(workspacesTable.issueId, issues.id))
      .where(eq(issues.projectId, projectId));

    if (wsRows.length === 0) {
      return { total: 0, confirmedReal: 0, confirmedFlake: 0, pending: 0, falseFlakeRate: 0 };
    }

    const wsIds = wsRows.map((r: { id: string }) => r.id);
    const decisions = await database
      .select()
      .from(testRetryDecisions)
      .where(inArray(testRetryDecisions.workspaceId, wsIds));

    const retried = decisions.filter((d: { decision: string }) => d.decision !== "real");
    const confirmedFlake = retried.filter((d: { finalOutcome: string }) => d.finalOutcome === "confirmed_flake").length;
    const confirmedReal = retried.filter((d: { finalOutcome: string }) => d.finalOutcome === "confirmed_real").length;
    const pending = retried.filter((d: { finalOutcome: string }) => d.finalOutcome === "pending").length;
    const falseFlakeRate = retried.length > 0 ? confirmedFlake / retried.length : 0;

    return {
      total: retried.length,
      confirmedFlake,
      confirmedReal,
      pending,
      falseFlakeRate,
    };
  }

  return {
    listFlakyTests,
    createFlakyTest,
    deleteFlakyTest,
    classifyFailure,
    recordRetryOutcome,
    getDecisionsForSession,
    getDecisionsForWorkspace,
    getTelemetry,
  };
}
