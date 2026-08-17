import type { Database } from "../db/index.js";
import { createSessionReadService, SessionReadError } from "../services/session-read.service.js";
import { searchTranscriptMessages } from "../repositories/session.repository.js";
import {
  getSessionOutput,
  getSessionOutputMeta,
  type SessionOutputMeta,
} from "../repositories/session/messages.js";
import { createRouter } from "../middleware/create-router.js";

import { queryInt } from "../middleware/query-params.js";
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

/**
 * Weak metadata ETag for the /output route. The tail size participates so a
 * tail response and a full response are never treated as the same
 * representation (both share the same underlying metadata).
 */
function buildOutputEtag(meta: SessionOutputMeta, tailBytes: number | undefined): string {
  return `W/"out-${meta.fileSize}-${Math.trunc(meta.fileMtimeMs)}-${meta.maxMessageId}-${tailBytes ?? "full"}"`;
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

    const limit = queryInt(c, "limit", { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });

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

  // GET /api/sessions/:sessionId/output[?tail=<bytes>]
  //
  // Conditional-GET is metadata-based: the ETag derives from the .out file's
  // size+mtime plus the max session_messages id (see getSessionOutputMeta), all
  // computed BEFORE any transcript read. A matching If-None-Match therefore
  // returns 304 having read zero file bytes and zero message rows — this route
  // is polled every ~4s per active workspace over multi-MB transcripts, so the
  // old shape (build the full body, hash it, then 304) still paid the whole
  // read on every poll. `?tail=<bytes>` bounds the file read to the transcript
  // tail (complete JSONL lines only), which is all the live panels render.
  router.get("/:sessionId/output", async (c) => {
    const sessionId = c.req.param("sessionId");
    const tailRaw = c.req.query("tail");
    let tailBytes: number | undefined;
    if (tailRaw !== undefined) {
      // Same exclusion as the workspaces pagination params (#511): `tailBytes` stays
      // undefined unless a positive integer was supplied — "no tail" is a distinct state
      // from "tail of N bytes", so a numeric default would change what gets returned.
      const n = Number.parseInt(tailRaw, 10);
      if (Number.isFinite(n) && n > 0) tailBytes = n;
    }

    const meta = await getSessionOutputMeta(sessionId, database);
    if (!meta) throw new SessionReadError("Session not found", "NOT_FOUND");
    const etag = buildOutputEtag(meta, tailBytes);
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    const result = await getSessionOutput(sessionId, database, { tailBytes });
    if (!result) throw new SessionReadError("Session not found", "NOT_FOUND");
    return new Response(JSON.stringify(result.messages), {
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
