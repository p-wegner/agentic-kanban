import { describe, expect, it } from "vitest";
import {
  parseTestTextOutput,
  parseTestResultsFromText,
  extractTextFromMessageData,
  createTestRunService,
} from "../services/test-run.service.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { sessionMessages, testRuns } from "@agentic-kanban/shared/schema";

/** Seed the minimal project → issue → workspace → session chain so session_messages FK holds. */
async function seedSession(db: TestDb, sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(schema.projects).values({ id: projectId, name: "T", repoPath: "/tmp/x", defaultBranch: "main", createdAt: now, updatedAt: now } as any);
  await db.insert(schema.projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now });
  await db.insert(schema.issues).values({ id: issueId, issueNumber: 1, title: "I", issueType: "bug", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(schema.workspaces).values({ id: workspaceId, issueId, branch: "feature/t", status: "active", createdAt: now, updatedAt: now });
  await db.insert(schema.sessions).values({ id: sessionId, workspaceId, startedAt: now });
}

describe("parseTestTextOutput — vitest console", () => {
  it("parses passing and failing default-reporter lines", () => {
    const out = [
      " ✓ src/foo.test.ts > suite a > does a thing 12ms",
      " × src/foo.test.ts > suite a > breaks badly 3ms",
      " ✓ src/bar.test.ts > b > works",
    ].join("\n");

    const records = parseTestTextOutput(out);
    expect(records).toEqual([
      { runner: "vitest", testName: "suite a > does a thing", file: "src/foo.test.ts", suite: undefined, passed: true, durationMs: 12 },
      { runner: "vitest", testName: "suite a > breaks badly", file: "src/foo.test.ts", suite: undefined, passed: false, durationMs: 3 },
      { runner: "vitest", testName: "b > works", file: "src/bar.test.ts", suite: undefined, passed: true, durationMs: undefined },
    ]);
  });

  it("strips ANSI color codes", () => {
    const out = "[32m ✓[0m src/x.test.ts > grp > green 5ms";
    const records = parseTestTextOutput(out);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ passed: true, testName: "grp > green", runner: "vitest" });
  });

  it("ignores skipped/todo glyphs", () => {
    const out = " ↓ src/x.test.ts > grp > skipme";
    expect(parseTestTextOutput(out)).toEqual([]);
  });
});

describe("parseTestTextOutput — playwright list reporter", () => {
  it("parses passing and failing list-reporter lines", () => {
    const out = [
      "  ✓  1 [chromium] › board.test.ts:12:3 › board › loads (1.2s)",
      "  ✘  2 [chromium] › board.test.ts:20:3 › board › drags (3.0s)",
      "  -  3 [chromium] › board.test.ts:30:3 › board › skipped",
    ].join("\n");

    const records = parseTestTextOutput(out);
    expect(records).toEqual([
      { runner: "playwright", testName: "board > loads", file: "board.test.ts", suite: undefined, passed: true, durationMs: 1200 },
      { runner: "playwright", testName: "board > drags", file: "board.test.ts", suite: undefined, passed: false, durationMs: 3000 },
    ]);
  });
});

describe("parseTestTextOutput — robustness (no false ingestion)", () => {
  it("returns nothing for arbitrary agent chatter", () => {
    const chatter = [
      "I'll now run the tests to verify the change.",
      "Reading file src/foo.ts",
      "The implementation looks correct. ✓ done!", // glyph but not a test line (no ' > ')
      "Summary: everything works.",
    ].join("\n");
    expect(parseTestTextOutput(chatter)).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(parseTestTextOutput("")).toEqual([]);
  });

  it("dedupes identical result lines", () => {
    const out = [
      " ✓ src/a.test.ts > g > t 1ms",
      " ✓ src/a.test.ts > g > t 1ms",
    ].join("\n");
    expect(parseTestTextOutput(out)).toHaveLength(1);
  });
});

describe("parseTestResultsFromText — JSON-first then text fallback", () => {
  it("parses an embedded vitest JSON reporter dump", () => {
    const json = JSON.stringify({
      testResults: [
        {
          testFilePath: "/repo/src/a.test.ts",
          assertionResults: [
            { fullName: "g > passes", status: "passed", duration: 4 },
            { fullName: "g > fails", status: "failed", duration: 2, failureMessages: ["boom"] },
          ],
        },
      ],
    });
    const blob = `running tests...\n${json}\ndone.`;
    const records = parseTestResultsFromText(blob);
    expect(records).toHaveLength(2);
    expect(records.map(r => r.passed)).toEqual([true, false]);
  });

  it("falls back to text parsing when there is no JSON", () => {
    const records = parseTestResultsFromText(" ✓ src/a.test.ts > g > t 1ms");
    expect(records).toHaveLength(1);
    expect(records[0].runner).toBe("vitest");
  });
});

describe("extractTextFromMessageData", () => {
  it("pulls console text out of a Claude tool_result stream-json line", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: " ✓ src/a.test.ts > g > works 2ms" }],
          },
        ],
      },
    });
    const text = extractTextFromMessageData(line);
    expect(text).toContain("✓ src/a.test.ts > g > works");
  });

  it("returns raw text unchanged when data is plain console output", () => {
    const raw = " ✓ src/a.test.ts > g > works 2ms";
    expect(extractTextFromMessageData(raw)).toContain("works");
  });
});

describe("ingestSession (DB-backed)", () => {
  it("ingests recognizable test results and feeds getFlaky", async () => {
    const { db } = createTestDb();
    const svc = createTestRunService(db);

    // 30 sessions: each reports the same test, ~half pass / half fail → flaky.
    for (let i = 0; i < 30; i++) {
      const sessionId = `sess-${i}`;
      const passed = i % 2 === 0;
      const glyph = passed ? "✓" : "×";
      const line = JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: [{ type: "text", text: `${glyph} src/a.test.ts > g > flaky 1ms` }] }] },
      });
      await seedSession(db, sessionId);
      await db.insert(sessionMessages).values({ sessionId, type: "stdout", data: line });
      const inserted = await svc.ingestSession(sessionId);
      expect(inserted).toBe(1);
    }

    const flaky = await svc.getFlaky({ minRuns: 5, windowDays: 30 });
    expect(flaky).toHaveLength(1);
    expect(flaky[0].testName).toBe("g > flaky");
    expect(flaky[0].totalRuns).toBe(30);
    expect(flaky[0].flakeRate).toBeGreaterThan(0.05);
    expect(flaky[0].flakeRate).toBeLessThan(0.95);
  });

  it("is idempotent per session (no double-count on re-exit)", async () => {
    const { db } = createTestDb();
    const svc = createTestRunService(db);
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: [{ type: "text", text: "✓ src/a.test.ts > g > t 1ms" }] }] },
    });
    await seedSession(db, "s1");
    await db.insert(sessionMessages).values({ sessionId: "s1", type: "stdout", data: line });

    expect(await svc.ingestSession("s1")).toBe(1);
    expect(await svc.ingestSession("s1")).toBe(0); // already ingested

    const rows = await db.select({ id: testRuns.id }).from(testRuns);
    expect(rows).toHaveLength(1);
  });

  it("ingests nothing from a non-test session", async () => {
    const { db } = createTestDb();
    const svc = createTestRunService(db);
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "I refactored the parser and everything looks good." }] },
    });
    await seedSession(db, "s2");
    await db.insert(sessionMessages).values({ sessionId: "s2", type: "stdout", data: line });

    expect(await svc.ingestSession("s2")).toBe(0);
    const rows = await db.select({ id: testRuns.id }).from(testRuns);
    expect(rows).toHaveLength(0);
  });
});
