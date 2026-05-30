import { eq, desc, gte, sql } from "drizzle-orm";
import { testRuns, flakyTestPins, sessionMessages } from "@agentic-kanban/shared/schema";
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

// ---- Plain-text console-output parsing (for auto-ingestion) ----
//
// Agent/CI sessions stream the *console* output of a test runner, not its JSON
// reporter. These parsers recognize per-test pass/fail lines so the radar can be
// fed automatically. They are deliberately conservative: lines that don't clearly
// describe a single test result are ignored, so non-test sessions produce nothing.

// Strip ANSI escape codes (color) that terminals/agents embed in output.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;

/**
 * A vitest default-reporter per-test line, e.g.:
 *   ✓ src/foo.test.ts > suite > does a thing 12ms
 *   × src/foo.test.ts > suite > breaks 3ms
 *   ✓ does a thing (when file shown on its own header line)
 * The status glyph is one of ✓ (pass), ×/✗ (fail), ↓/- (skip).
 */
const VITEST_LINE_RE = /^\s*(?<glyph>[✓✔×✗❯↓])\s+(?<body>.+?)(?:\s+(?<dur>\d+(?:\.\d+)?)\s*ms)?\s*$/;

/**
 * A playwright list-reporter per-test line, e.g.:
 *   ✓  1 [chromium] › board.test.ts:12:3 › board › loads (1.2s)
 *   ✘  2 [chromium] › board.test.ts:20:3 › board › drags (3.0s)
 *   -  3 [chromium] › board.test.ts:30:3 › board › skipped
 */
const PLAYWRIGHT_LINE_RE = /^\s*(?<glyph>[✓✔✘×✗-])\s+\d+\s+(?<body>.+?)(?:\s+\((?<dur>[\d.]+)(?<unit>m?s)\))?\s*$/;

function vitestGlyphPassed(glyph: string): boolean | null {
  if (glyph === "✓" || glyph === "✔") return true;
  if (glyph === "×" || glyph === "✗") return false;
  return null; // ↓/❯ etc. — skip / not a terminal result
}

function playwrightGlyphPassed(glyph: string): boolean | null {
  if (glyph === "✓" || glyph === "✔") return true;
  if (glyph === "✘" || glyph === "×" || glyph === "✗") return false;
  return null; // "-" skipped
}

/** Split a "file > suite > test" or "file:line:col › suite › test" body into file + name. */
function splitBody(body: string, sep: RegExp): { file?: string; testName: string } {
  const parts = body.split(sep).map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return { testName: body.trim() };
  const first = parts[0];
  // A file segment looks like a path with a test/spec extension, optionally with :line:col.
  const fileMatch = /\.(?:test|spec)\.[tj]sx?(?::\d+(?::\d+)?)?$/i.test(first)
    || /[\\/].+\.[tj]sx?$/i.test(first);
  if (fileMatch && parts.length > 1) {
    const file = first.replace(/:\d+(?::\d+)?$/, "");
    return { file, testName: parts.slice(1).join(" > ") };
  }
  return { testName: parts.join(" > ") };
}

/**
 * Parse the console output of a test runner (vitest or playwright) line-by-line.
 * Returns one record per recognized test result. Unrecognized lines are skipped,
 * so feeding arbitrary agent chatter yields an empty array.
 */
export function parseTestTextOutput(
  raw: string,
): Omit<TestRunRecord, "sessionId" | "commitSha">[] {
  const results: Omit<TestRunRecord, "sessionId" | "commitSha">[] = [];
  const seen = new Set<string>();

  const push = (rec: Omit<TestRunRecord, "sessionId" | "commitSha">) => {
    const key = `${rec.runner}|${rec.testName}|${rec.passed}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(rec);
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI_RE, "");
    if (!line.trim()) continue;

    // Playwright list reporter: "<glyph>  <index> [project] › file:line › ... › test"
    const pw = line.match(PLAYWRIGHT_LINE_RE);
    if (pw?.groups && /›|\[[^\]]+\]/.test(pw.groups.body)) {
      const passed = playwrightGlyphPassed(pw.groups.glyph);
      if (passed === null) continue;
      // Drop a leading "[project]" tag before splitting.
      const body = pw.groups.body.replace(/^\[[^\]]+\]\s*›?\s*/, "");
      const { file, testName } = splitBody(body, /\s+›\s+/);
      if (!testName) continue;
      const dur = pw.groups.dur ? Number(pw.groups.dur) * (pw.groups.unit === "s" ? 1000 : 1) : undefined;
      push({ runner: "playwright", testName, file, suite: undefined, passed, durationMs: dur != null ? Math.round(dur) : undefined });
      continue;
    }

    // Vitest default reporter: "<glyph> file > suite > test  Nms"
    const vt = line.match(VITEST_LINE_RE);
    if (vt?.groups && vt.groups.body.includes(">")) {
      const passed = vitestGlyphPassed(vt.groups.glyph);
      if (passed === null) continue;
      const { file, testName } = splitBody(vt.groups.body, /\s+>\s+/);
      if (!testName) continue;
      push({ runner: "vitest", testName, file, suite: undefined, passed, durationMs: vt.groups.dur ? Math.round(Number(vt.groups.dur)) : undefined });
      continue;
    }
  }

  return results;
}

/**
 * Best-effort parse of an arbitrary text blob that may contain either a JSON
 * reporter dump (somewhere within it) or plain console output. Tries JSON first
 * (whole string, then any embedded `{...}` object), falling back to line parsing.
 */
export function parseTestResultsFromText(
  raw: string,
): Omit<TestRunRecord, "sessionId" | "commitSha">[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Whole-string JSON?
  if (trimmed.startsWith("{")) {
    const json = parseTestOutput(trimmed);
    if (json.length > 0) return json;
  }

  // Embedded JSON object containing a reporter shape (testResults/files/suites)?
  const jsonMatch = trimmed.match(/\{[\s\S]*"(?:testResults|files|suites)"[\s\S]*\}/);
  if (jsonMatch) {
    const json = parseTestOutput(jsonMatch[0]);
    if (json.length > 0) return json;
  }

  return parseTestTextOutput(trimmed);
}

// ---- Session-output extraction ----
//
// Session messages persist raw agent stdout: for Claude/Copilot this is
// stream-json / JSONL where the test runner's console output is buried inside
// `tool_result` content. For plain (`raw`) agents the data is the console text
// directly. We walk each line, pull out any human-readable text we can find, and
// concatenate it so the text parsers above can scan for test-result lines.

/** Recursively collect string values that look like console text from a parsed JSON value. */
function collectText(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.length > 0) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectText(v, out);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // tool_result content lives under `content` (string or [{type:"text",text}]) and
    // sometimes a top-level `text`/`output`/`stdout`/`result` field.
    for (const key of ["content", "text", "output", "stdout", "result", "message"]) {
      if (key in obj) collectText(obj[key], out);
    }
  }
}

/**
 * Extract candidate console text from one persisted stdout message's `data`.
 * Handles: (a) plain text, (b) a single JSON object/JSONL line whose tool_result
 * content carries the runner output.
 */
export function extractTextFromMessageData(data: string): string {
  const parts: string[] = [];
  let sawJson = false;
  for (const line of data.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        collectText(JSON.parse(t), parts);
        sawJson = true;
        continue;
      } catch { /* not a complete JSON line — fall through to raw */ }
    }
    if (!sawJson) parts.push(line);
  }
  // If nothing JSON-structured was found, treat the whole blob as raw console text.
  if (parts.length === 0) return data;
  return parts.join("\n");
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

  /**
   * Auto-ingest test results from a completed agent/CI session's persisted output.
   * Idempotent per session: if any test_runs row already exists for this session
   * (e.g. it was ingested on a previous exit, or via a manual POST), it is skipped.
   * Returns the number of records inserted. Robust to non-test sessions — they
   * yield no parseable results and insert nothing.
   */
  async function ingestSession(sessionId: string): Promise<number> {
    // Skip if this session already has recorded runs (idempotent across re-exits).
    const existing = await database
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(eq(testRuns.sessionId, sessionId))
      .limit(1);
    if (existing.length > 0) return 0;

    const msgs = await database
      .select({ type: sessionMessages.type, data: sessionMessages.data })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.id);

    const textParts: string[] = [];
    for (const m of msgs) {
      if ((m.type === "stdout" || m.type === "stderr") && m.data) {
        textParts.push(extractTextFromMessageData(m.data));
      }
    }
    if (textParts.length === 0) return 0;

    const records = parseTestResultsFromText(textParts.join("\n"));
    if (records.length === 0) return 0;

    await recordRuns(records.map(r => ({ ...r, sessionId })));
    return records.length;
  }

  return { recordRuns, getFlaky, pinTest, unpinTest, getPinnedTests, ingestSession };
}

export type TestRunService = ReturnType<typeof createTestRunService>;
