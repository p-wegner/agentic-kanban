// @gate:always-run — scans the server src tree for unbounded session-message reads; no import edge (#647).
/**
 * #401 — bounded session_messages reads + sync-free hot paths.
 *
 *  - getSessionMessagesForSessions must issue per-session windowed queries (LIMIT
 *    per session, served by the (session_id, id) index from migration 0113) instead
 *    of selecting every row's data payload, while preserving the caller's
 *    first-match-wins extraction semantics (workspace-summary.service
 *    collectLastToolAndMessages walks rows newest-first per session).
 *  - getSessionStdoutMessages (agent-questions DB fallback) must be bounded the
 *    same way while still surfacing the terminal `result` event, in ascending order.
 *  - Static guard: no synchronous fs/git call remains reachable from the
 *    workspace-summary rebuild path, the monitor excerpt path, or the project
 *    stats path.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desc, inArray } from "drizzle-orm";
import {
  projects,
  projectStatuses,
  issues,
  workspaces,
  sessions,
  sessionMessages,
} from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { getSessionMessagesForSessions } from "../repositories/workspace-summary.repository.js";
import { getSessionStdoutMessages } from "../repositories/agent-questions.repository.js";
import { extractAssistantMessage, extractToolName } from "../lib/session-message-extraction.js";

type Db = ReturnType<typeof createTestDb>["db"];

const PROJECT_ID = "proj-bounded";
let seedIssueNumber = 500;

async function seedSession(db: Db, key: string): Promise<string> {
  const statusId = "status-bounded";
  await db.insert(projects).values({ id: PROJECT_ID, name: "p", repoPath: "/tmp/p" }).onConflictDoNothing();
  await db.insert(projectStatuses).values({ id: statusId, projectId: PROJECT_ID, name: "In Progress", sortOrder: 1 }).onConflictDoNothing();
  const issueId = `issue-${key}`;
  await db.insert(issues).values({ id: issueId, issueNumber: seedIssueNumber++, title: "T", statusId, projectId: PROJECT_ID });
  const workspaceId = `ws-${key}`;
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: `feature/${key}`, status: "active" });
  const sessionId = `sess-${key}`;
  await db.insert(sessions).values({ id: sessionId, workspaceId, status: "stopped" });
  return sessionId;
}

function assistantTextLine(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

function toolUseLine(name: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });
}

/** The exact extraction loop from workspace-summary.service collectLastToolAndMessages. */
function runCallerExtraction(rows: Array<{ sessionId: string; data: string | null }>) {
  const lastToolBySession = new Map<string, string>();
  const lastAssistantMsgBySession = new Map<string, string>();
  for (const msg of rows) {
    const hasTool = lastToolBySession.has(msg.sessionId);
    const hasMsg = lastAssistantMsgBySession.has(msg.sessionId);
    if ((hasTool && hasMsg) || !msg.data) continue;
    if (!hasTool) {
      const toolName = extractToolName(msg.data);
      if (toolName) lastToolBySession.set(msg.sessionId, toolName);
    }
    if (!hasMsg) {
      const assistantMessage = extractAssistantMessage(msg.data);
      if (assistantMessage) lastAssistantMsgBySession.set(msg.sessionId, assistantMessage);
    }
  }
  return { lastToolBySession, lastAssistantMsgBySession };
}

describe("getSessionMessagesForSessions is bounded per session (#401)", () => {
  it("returns at most the window per session even for a many-row session, and preserves extraction results", async () => {
    const { db } = createTestDb();
    const manyId = await seedSession(db, "many");
    const mixedId = await seedSession(db, "mixed");

    // 200 rows: old matches early (must NOT win), then noise, then the newest
    // matches near the end — well inside any reasonable per-session window.
    const manyRows: string[] = [toolUseLine("OldTool"), assistantTextLine("old reply")];
    for (let i = 0; i < 190; i++) manyRows.push(`noise line ${i} (not json)`);
    manyRows.push(toolUseLine("Bash"));
    manyRows.push(assistantTextLine("newest reply"));
    for (let i = 0; i < 6; i++) manyRows.push(`{"type":"system","subtype":"noise${i}"}`);
    for (const data of manyRows) {
      await db.insert(sessionMessages).values({ sessionId: manyId, type: "stdout", data });
    }

    // Mixed small session: tool row older than the assistant row.
    const mixedRows = [
      "garbage",
      toolUseLine("Read"),
      assistantTextLine("mixed reply"),
      `{"type":"system","subtype":"init"}`,
    ];
    for (const data of mixedRows) {
      await db.insert(sessionMessages).values({ sessionId: mixedId, type: "stdout", data });
    }

    const bounded = await getSessionMessagesForSessions([manyId, mixedId], db);

    // Bounded: the many-row session contributes at most its window, not all 200 rows.
    const manyReturned = bounded.filter((r) => r.sessionId === manyId);
    expect(manyReturned.length).toBeLessThanOrEqual(50);
    expect(manyReturned.length).toBeGreaterThan(0);
    const mixedReturned = bounded.filter((r) => r.sessionId === mixedId);
    expect(mixedReturned.length).toBe(mixedRows.length);

    // Newest-first within each session (the ordering the caller depends on).
    expect(mixedReturned[0].data).toBe(`{"type":"system","subtype":"init"}`);
    expect(mixedReturned[mixedReturned.length - 1].data).toBe("garbage");

    // Same extraction results as the old unbounded ORDER BY id DESC query.
    const unbounded = await db
      .select({ sessionId: sessionMessages.sessionId, data: sessionMessages.data })
      .from(sessionMessages)
      .where(inArray(sessionMessages.sessionId, [manyId, mixedId]))
      .orderBy(desc(sessionMessages.id));
    const before = runCallerExtraction(unbounded);
    const after = runCallerExtraction(bounded);
    expect(after.lastToolBySession).toEqual(before.lastToolBySession);
    expect(after.lastAssistantMsgBySession).toEqual(before.lastAssistantMsgBySession);
    // And the concrete values are the NEWEST matches, not the oldest.
    expect(after.lastToolBySession.get(manyId)).toBe("Bash");
    expect(after.lastAssistantMsgBySession.get(manyId)).toBe("newest reply");
    expect(after.lastToolBySession.get(mixedId)).toBe("Read");
    expect(after.lastAssistantMsgBySession.get(mixedId)).toBe("mixed reply");
  });

  it("returns an empty list for sessions without rows", async () => {
    const { db } = createTestDb();
    const emptyId = await seedSession(db, "empty");
    expect(await getSessionMessagesForSessions([emptyId], db)).toEqual([]);
  });
});

describe("getSessionStdoutMessages is bounded (#401)", () => {
  it("caps a many-row session while still surfacing the terminal result event, ascending", async () => {
    const { db } = createTestDb();
    const sid = await seedSession(db, "aq-many");

    const denial = JSON.stringify({
      type: "result",
      permission_denials: [{
        tool_name: "AskUserQuestion",
        tool_use_id: "tu-bounded-1",
        tool_input: { questions: [{ question: "Pick?", options: [{ label: "A" }] }] },
      }],
    });
    for (let i = 0; i < 120; i++) {
      await db.insert(sessionMessages).values({ sessionId: sid, type: "stdout", data: `line ${i}` });
    }
    await db.insert(sessionMessages).values({ sessionId: sid, type: "stdout", data: denial });

    const rows = await getSessionStdoutMessages(sid, db);
    expect(rows.length).toBeLessThanOrEqual(50);
    // Ascending order preserved: the newest row (the denial) is LAST, as with the
    // old unbounded rowid-ordered select.
    expect(rows[rows.length - 1].data).toBe(denial);
    expect(rows.some((r) => r.data === denial)).toBe(true);
  });
});

describe("sync-free hot paths (#401 static guard)", () => {
  const serverSrc = join(import.meta.dirname!, "..");

  /** Read a source file with comments stripped, so historical doc comments naming
   *  the retired sync functions don't trip the guard — only live code counts. */
  function read(rel: string): string {
    return readFileSync(join(serverSrc, rel), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  it("workspace-summary tail loop and monitor excerpts use the async tail reader only", () => {
    // agent-questions/listing.ts was the one call site #401 missed (fixed in the
    // 2026-08-11 perf round, G3) — listed here so it can't regress to the sync reader.
    for (const rel of ["services/workspace-summary.service.ts", "startup/monitor-helpers.ts", "services/agent-questions/listing.ts"]) {
      const src = read(rel);
      // The sync tail reader must not appear (readSessionStdoutFileTailAsync is fine).
      expect(src).not.toMatch(/readSessionStdoutFileTail(?!Async)/);
      // No direct sync fs reads either. (existsSync is a metadata stat, not a payload
      // read, and is allowed on the summary path.)
      expect(src).not.toMatch(/\b(openSync|readSync|readFileSync|fstatSync)\b/);
    }
  });

  it("git-info.service has no sync git spawn left (sync twins deleted)", () => {
    const src = read("services/git-info.service.ts");
    expect(src).not.toMatch(/\b(gitExecSync|execFileSync|execSync)\b/);
    expect(src).not.toMatch(/\bfunction getProjectGitStats\(/);
  });
});
