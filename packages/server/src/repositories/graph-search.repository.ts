import { and, eq, or, sql } from "drizzle-orm";
import { issues } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * Server-side graph search (#370).
 *
 * ── Why this shape, and not the client-side index the ticket sketched ──
 *
 * `/api/projects/:id/graph` stopped shipping `description` (309,477 -> ~62,000 gzipped bytes), but
 * descriptions were LOAD-BEARING for the graph's search box, so the diet silently turned
 * search-by-description into search-by-title — the semantics-for-bytes trade #345 refused twice.
 *
 * The ticket offered two shapes and asked for a deliberate choice. I built (b), the lazy
 * `{issueId, haystack}` index, and MEASURED it on this board: **364,380 gzipped bytes** — 5.9× the
 * graph payload it was meant to protect, and larger than the 309,477 the ticket exists to beat. Of
 * course it is: it is every description of every issue, which is precisely what was just removed.
 * A user who searched once would have paid MORE than before the diet.
 *
 * So (a): the server matches and returns only the issue IDs. Descriptions never cross the wire,
 * the response is a few KB whatever the board's size, and matching stays EXACT — no truncated
 * haystack quietly missing a term deep in a long description, which would have been the same class
 * of silent semantics loss all over again.
 *
 * The cost is one request per (debounced) query, and search depending on the server. The client
 * keeps its title-only filter as the fallback for exactly that reason: a slow or failed search
 * degrades to today's behaviour, never to an empty graph.
 */

/** Escape LIKE metacharacters so a query containing `%` or `_` matches itself. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function searchGraphIssueIds(
  projectId: string,
  query: string,
  database: Database = db,
): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const pattern = `%${escapeLike(trimmed.toLowerCase())}%`;
  const rows = await database
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.projectId, projectId),
      or(
        // LOWER() on both sides rather than trusting collation: the columns are not declared
        // NOCASE, so a bare LIKE would be case-sensitive here and inconsistent with the client's
        // fallback, which lowercases both sides.
        sql`LOWER(${issues.title}) LIKE ${pattern} ESCAPE '\\'`,
        sql`LOWER(COALESCE(${issues.description}, '')) LIKE ${pattern} ESCAPE '\\'`,
      ),
    ));
  return rows.map((row) => row.id);
}
