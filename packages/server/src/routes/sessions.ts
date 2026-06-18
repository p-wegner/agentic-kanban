import { createHash } from "node:crypto";
import type { Database } from "../db/index.js";
import { createSessionReadService } from "../services/session-read.service.js";
import { searchTranscriptMessages } from "../repositories/session.repository.js";
import { createRouter } from "../middleware/create-router.js";

export interface TranscriptSearchResult {
  messageId: number;
  sessionId: string;
  snippet: string;
  matchOffset: number;
  messageCreatedAt: string;
  workspaceId: string;
  branch: string;
  workspaceStatus: string;
  projectId: string;
  projectName: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueStatusName: string;
  sessionStartedAt: string;
  sessionStatus: string;
  executor: string;
}

export interface TranscriptSearchResponse {
  results: TranscriptSearchResult[];
  totalMatches: number;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const SNIPPET_RADIUS = 80;

function makeSnippet(text: string, matchIdx: number): string {
  const start = Math.max(0, matchIdx - SNIPPET_RADIUS);
  const end = Math.min(text.length, matchIdx + SNIPPET_RADIUS);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";
  return snippet;
}

export function createSessionsRoute(database: Database) {
  const router = createRouter();
  const sessionReadService = createSessionReadService({ database });

  // GET /api/sessions/search?q=...&projectId=...&status=...&provider=...&limit=...
  router.get("/search", async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q || q.length < 2) {
      return c.json({ results: [], totalMatches: 0 } satisfies TranscriptSearchResponse);
    }

    const projectId = c.req.query("projectId");

    const limit = Math.min(
      parseInt(c.req.query("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
      MAX_LIMIT,
    );

    const statusFilter = c.req.query("status"); // e.g. "In Progress", "In Review", "Done"
    const providerFilter = c.req.query("provider"); // e.g. "claude-code", "codex"

    const rows = await searchTranscriptMessages(
      { q, projectId, statusFilter, providerFilter, limit },
      database,
    );

    const results: TranscriptSearchResult[] = rows.map((row) => {
      const data = row.messageData ?? "";
      const matchIdx = data.toLowerCase().indexOf(q.toLowerCase());
      return {
        messageId: row.messageId,
        sessionId: row.sessionId,
        snippet: makeSnippet(data, matchIdx >= 0 ? matchIdx : 0),
        matchOffset: matchIdx,
        messageCreatedAt: row.messageCreatedAt,
        workspaceId: row.workspaceId,
        branch: row.branch,
        workspaceStatus: row.workspaceStatus,
        projectId: row.projectId,
        projectName: row.projectName,
        issueId: row.issueId,
        issueNumber: row.issueNumber,
        issueTitle: row.issueTitle,
        issueStatusName: row.issueStatusName,
        sessionStartedAt: row.sessionStartedAt,
        sessionStatus: row.sessionStatus,
        executor: row.executor,
      };
    });

    return c.json({
      results,
      totalMatches: results.length,
    } satisfies TranscriptSearchResponse);
  });

  // GET /api/sessions/:sessionId/output
  router.get("/:sessionId/output", async (c) => {
    const sessionId = c.req.param("sessionId");
    const messages = await sessionReadService.getOutput(sessionId);
    const body = JSON.stringify(messages);
    const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: etag },
    });
  });

  // GET /api/sessions/:sessionId/stats
  router.get("/:sessionId/stats", async (c) => {
    const sessionId = c.req.param("sessionId");
    return c.json(await sessionReadService.getStats(sessionId));
  });

  // GET /api/sessions/:sessionId/summary
  router.get("/:sessionId/summary", async (c) => {
    const sessionId = c.req.param("sessionId");
    return c.json(await sessionReadService.getSummary(sessionId));
  });

  return router;
}
