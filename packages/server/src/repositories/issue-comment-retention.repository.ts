import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * Persistence half of issue-comment retention (#738). The POLICY — which authors and kinds are
 * sweepable, how the cutoff is derived, every fail-closed edge — lives in
 * `services/issue-comment-retention.service.ts`; this file only knows how to ask SQLite about
 * the set the policy describes. Services must not run raw persistence
 * (`services-bypass-repositories`), and the CTE below is exactly the kind of query that rule
 * exists to keep behind a seam.
 */
export interface CommentRetentionScope {
  /** Comment authors that may be swept. Nothing outside this list is ever considered. */
  authors: readonly string[];
  /** Comment kinds that may be swept. */
  kinds: readonly string[];
  /** Status-column names counted as terminal (the join is INNER — no status means KEEP). */
  terminalStatusNames: readonly string[];
  /** Only comments created strictly before this ISO timestamp are eligible. */
  cutoff: string;
  /** Newest N comments of each (issue, kind, workspace) thread are never swept. */
  keepPerThread: number;
}

const quotedList = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/**
 * Every row eligible by provenance, status and age, ranked within its own thread (1 = newest).
 * The keep-per-thread floor is applied by the callers, not here, so a plan can report how many
 * rows the floor protected instead of hiding them.
 */
const candidateCte = (scope: CommentRetentionScope) => sql`
  with candidate as (
    select
      c.id as id,
      c.kind as kind,
      c.author as author,
      length(c.body) + length(coalesce(c.payload, '')) as bytes,
      row_number() over (
        partition by c.issue_id, c.kind, ifnull(c.workspace_id, '')
        order by c.created_at desc, c.id desc
      ) as rn
    from issue_comments c
    join issues i on i.id = c.issue_id
    join project_statuses s on s.id = i.status_id
    where c.author in (${quotedList(scope.authors)})
      and c.kind in (${quotedList(scope.kinds)})
      and s.name in (${quotedList(scope.terminalStatusNames)})
      and c.created_at < ${scope.cutoff}
  )`;

export async function countAllIssueComments(database: Database = db): Promise<number> {
  const rows = await database.all<{ n: number }>(sql`select count(*) as n from issue_comments`);
  return Number(rows[0]?.n ?? 0);
}

/** Rows matching the scope BEFORE the keep-per-thread floor is applied. */
export async function countRetentionEligible(
  scope: CommentRetentionScope,
  database: Database = db,
): Promise<number> {
  const rows = await database.all<{ n: number }>(sql`${candidateCte(scope)} select count(*) as n from candidate`);
  return Number(rows[0]?.n ?? 0);
}

export interface RetentionDeletableGroup {
  kind: string;
  author: string;
  rows: number;
  bytes: number;
}

/** What a run would actually delete, grouped by (author, kind). */
export async function listRetentionDeletableGroups(
  scope: CommentRetentionScope,
  database: Database = db,
): Promise<RetentionDeletableGroup[]> {
  const rows = await database.all<{ kind: string; author: string; rows: number; bytes: number }>(sql`
    ${candidateCte(scope)}
    select kind, author, count(*) as rows, sum(bytes) as bytes
    from candidate where rn > ${scope.keepPerThread}
    group by kind, author order by rows desc`);
  return rows.map((r) => ({
    kind: r.kind,
    author: r.author,
    rows: Number(r.rows),
    bytes: Number(r.bytes ?? 0),
  }));
}

/** Delete the scope's rows above the keep-per-thread floor. Called only after an explicit apply. */
export async function deleteRetentionDeletable(
  scope: CommentRetentionScope,
  database: Database = db,
): Promise<void> {
  await database.run(sql`
    ${candidateCte(scope)}
    delete from issue_comments
    where id in (select id from candidate where rn > ${scope.keepPerThread})`);
}
