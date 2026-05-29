import { eq, desc, gte, sql } from "drizzle-orm";
import { testRuns, flakyTestPins } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";

export interface TestRunRecord {
  sessionId: string;
  commitSha?: string;
  testName: string;
  file?: string;
  suite?: string;
  passed: boolean;
  durationMs?: number;
  errorMessage?: string;
  runner: "vitest" | "playwright";
}

export interface FlakyTestEntry {
  testName: string;
  file: string | null;
  suite: string | null;
  runner: string;
  totalRuns: number;
  passCount: number;
  failCount: number;
  flakeRate: number; // 0..1
  score: number;    // flakeRate * log(frequency), for sorting
  lastSeen: string;
  isPinned: boolean;
  lastError: string | null;
}

// ---- Vitest JSON reporter output shapes ----
interface VitestTestResult {
  name: string;
  status: "pass" | "fail" | "skip" | "todo";
  duration?: number;
  failureMessages?: string[];
}

interface VitestSuite {
  name: string;
  filepath?: string;
  tests?: VitestTestResult[];
  suites?: VitestSuite[];
}

interface VitestJsonOutput {
  testResults?: Array<{
    testFilePath?: string;
    assertionResults?: Array<{
      fullName?: string;
      title?: string;
      ancestorTitles?: string[];
      status: "passed" | "failed" | "skipped" | "pending";
      duration?: number;
      failureMessages?: string[];
    }>;
  }>;
  files?: VitestSuite[];
}

// ---- Playwright JSON reporter output shapes ----
interface PlaywrightTest {
  title: string;
  status: "passed" | "failed" | "skipped" | "timedOut" | "interrupted";
  duration: number;
  errors?: Array<{ message?: string }>;
}

interface PlaywrightSuite {
  title: string;
  file?: string;
  specs?: Array<{
    title: string;
    tests?: PlaywrightTest[];
  }>;
  suites?: PlaywrightSuite[];
}

interface PlaywrightJsonOutput {
  suites?: PlaywrightSuite[];
}

function flattenVitestSuites(
  suites: VitestSuite[],
  results: Omit<TestRunRecord, "sessionId" | "commitSha" | "runner">[],
  parentSuite = "",
): void {
  for (const suite of suites) {
    const suiteName = parentSuite ? `${parentSuite} > ${suite.name}` : suite.name;
    for (const test of suite.tests ?? []) {
      if (test.status === "skip" || test.status === "todo") continue;
      results.push({
        testName: `${suiteName} > ${test.name}`,
        file: suite.filepath ?? undefined,
        suite: suiteName,
        passed: test.status === "pass",
        durationMs: test.duration != null ? Math.round(test.duration) : undefined,
        errorMessage: test.failureMessages?.[0]?.slice(0, 500) ?? undefined,
      });
    }
    if (suite.suites?.length) {
      flattenVitestSuites(suite.suites, results, suiteName);
    }
  }
}

/**
 * Parse vitest JSON reporter output and return normalized records.
 * Supports both jest-compat (testResults[].assertionResults) and native (files[]) formats.
 */
export function parseVitestJson(
  raw: string,
): Omit<TestRunRecord, "sessionId" | "commitSha">[] {
  let parsed: VitestJsonOutput;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const results: Omit<TestRunRecord, "sessionId" | "commitSha">[] = [];

  // jest-compat format
  if (Array.isArray(parsed.testResults)) {
    for (const file of parsed.testResults) {
      for (const t of file.assertionResults ?? []) {
        if (t.status === "skipped" || t.status === "pending") continue;
        const name = t.fullName ?? [...(t.ancestorTitles ?? []), t.title ?? ""].filter(Boolean).join(" > ");
        results.push({
          runner: "vitest",
          testName: name,
          file: file.testFilePath ?? undefined,
          suite: t.ancestorTitles?.join(" > ") ?? undefined,
          passed: t.status === "passed",
          durationMs: t.duration != null ? Math.round(t.duration) : undefined,
          errorMessage: t.failureMessages?.[0]?.slice(0, 500) ?? undefined,
        });
      }
    }
    return results;
  }

  // Native vitest files[] format
  if (Array.isArray(parsed.files)) {
    const flat: Omit<TestRunRecord, "sessionId" | "commitSha" | "runner">[] = [];
    flattenVitestSuites(parsed.files, flat);
    return flat.map(r => ({ ...r, runner: "vitest" as const }));
  }

  return results;
}

/**
 * Parse playwright JSON reporter output and return normalized records.
 */
export function parsePlaywrightJson(
  raw: string,
): Omit<TestRunRecord, "sessionId" | "commitSha">[] {
  let parsed: PlaywrightJsonOutput;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const results: Omit<TestRunRecord, "sessionId" | "commitSha">[] = [];

  function walkSuites(suites: PlaywrightSuite[], fileHint?: string): void {
    for (const suite of suites) {
      const file = suite.file ?? fileHint;
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          if (test.status === "skipped" || test.status === "interrupted") continue;
          results.push({
            runner: "playwright",
            testName: `${suite.title} > ${spec.title}`,
            file: file ?? undefined,
            suite: suite.title,
            passed: test.status === "passed",
            durationMs: Math.round(test.duration),
            errorMessage: test.errors?.[0]?.message?.slice(0, 500) ?? undefined,
          });
        }
      }
      if (suite.suites?.length) walkSuites(suite.suites, file);
    }
  }

  walkSuites(parsed.suites ?? []);
  return results;
}

/**
 * Auto-detect format and parse test output from a JSON string.
 */
export function parseTestOutput(
  raw: string,
  hint?: "vitest" | "playwright",
): Omit<TestRunRecord, "sessionId" | "commitSha">[] {
  if (hint === "playwright") return parsePlaywrightJson(raw);
  if (hint === "vitest") return parseVitestJson(raw);
  // Heuristic: playwright output has top-level "suites" array
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(obj.suites) && !Array.isArray(obj.testResults) && !Array.isArray(obj.files)) {
      return parsePlaywrightJson(raw);
    }
  } catch { /* ignore */ }
  return parseVitestJson(raw);
}

// ---- DB operations ----

export function createTestRunService(database: Database) {
  async function recordRuns(records: TestRunRecord[]): Promise<void> {
    if (records.length === 0) return;
    const batchSize = 50;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await database.insert(testRuns).values(
        batch.map(r => ({
          sessionId: r.sessionId,
          commitSha: r.commitSha ?? null,
          testName: r.testName,
          file: r.file ?? null,
          suite: r.suite ?? null,
          passed: r.passed,
          durationMs: r.durationMs ?? null,
          errorMessage: r.errorMessage ?? null,
          runner: r.runner,
          recordedAt: new Date().toISOString(),
        })),
      );
    }
  }

  async function getFlaky(opts: {
    limit?: number;
    minRuns?: number;
    windowDays?: number;
  } = {}): Promise<FlakyTestEntry[]> {
    const { limit = 50, minRuns = 5, windowDays = 30 } = opts;
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const rows = await database
      .select({
        testName: testRuns.testName,
        file: testRuns.file,
        suite: testRuns.suite,
        runner: testRuns.runner,
        totalRuns: sql<number>`count(*)`,
        passCount: sql<number>`sum(case when ${testRuns.passed} = 1 then 1 else 0 end)`,
        failCount: sql<number>`sum(case when ${testRuns.passed} = 0 then 1 else 0 end)`,
        lastSeen: sql<string>`max(${testRuns.recordedAt})`,
        lastError: sql<string | null>`(
          select t2.error_message from test_runs t2
          where t2.test_name = ${testRuns.testName} and t2.passed = 0
          order by t2.recorded_at desc limit 1
        )`,
      })
      .from(testRuns)
      .where(gte(testRuns.recordedAt, cutoff))
      .groupBy(testRuns.testName, testRuns.file, testRuns.suite, testRuns.runner)
      .having(sql`count(*) >= ${minRuns}`);

    const pins = await database.select({ testName: flakyTestPins.testName }).from(flakyTestPins);
    const pinnedSet = new Set(pins.map(p => p.testName));

    const flaky: FlakyTestEntry[] = [];
    for (const row of rows) {
      const total = Number(row.totalRuns);
      const fail = Number(row.failCount);
      const pass = Number(row.passCount);
      const flakeRate = total > 0 ? fail / total : 0;
      if (flakeRate < 0.05 || flakeRate > 0.95) continue;
      flaky.push({
        testName: row.testName,
        file: row.file,
        suite: row.suite,
        runner: row.runner,
        totalRuns: total,
        passCount: pass,
        failCount: fail,
        flakeRate,
        score: flakeRate * Math.log1p(total),
        lastSeen: row.lastSeen,
        isPinned: pinnedSet.has(row.testName),
        lastError: row.lastError ?? null,
      });
    }

    flaky.sort((a, b) => b.score - a.score);
    return flaky.slice(0, limit);
  }

  async function pinTest(testName: string, file?: string): Promise<void> {
    await database
      .insert(flakyTestPins)
      .values({ testName, file: file ?? null, pinnedAt: new Date().toISOString() })
      .onConflictDoNothing();
  }

  async function unpinTest(testName: string): Promise<void> {
    await database.delete(flakyTestPins).where(eq(flakyTestPins.testName, testName));
  }

  async function getPinnedTests(): Promise<Array<{ testName: string; file: string | null; pinnedAt: string }>> {
    return database
      .select({ testName: flakyTestPins.testName, file: flakyTestPins.file, pinnedAt: flakyTestPins.pinnedAt })
      .from(flakyTestPins)
      .orderBy(desc(flakyTestPins.pinnedAt));
  }

  return { recordRuns, getFlaky, pinTest, unpinTest, getPinnedTests };
}

export type TestRunService = ReturnType<typeof createTestRunService>;
