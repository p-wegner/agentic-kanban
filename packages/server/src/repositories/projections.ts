import { issueDependencies, issues, preferences, projectStatuses, sessions } from "@agentic-kanban/shared/schema";

/**
 * The repository layer's shared column projections (#732).
 *
 * #732 measured the repository layer as the second-largest duplication cluster in the tree.
 * Re-measuring it here with token-windowed clone detection, the largest clone runs between
 * repository files were not query LOGIC — the `where` clauses genuinely differ — but the
 * `select({...})` PROJECTIONS: the same column lists, written out again per table, per
 * accessor. `{ id: projectStatuses.id, name: projectStatuses.name }` appeared in nine
 * files; the issue identity triple in twenty places; the dependency edge's own four columns
 * in five.
 *
 * That is worth a module rather than a comment because a projection is a CONTRACT, not
 * boilerplate: `board-status.repository.ts` carries a long note explaining that its
 * `workspaces` projection is deliberately slim because `SELECT *` dragged megabytes of
 * cached JSON through the driver per `get_board_status` call (#418 G17). A projection that
 * exists once can carry that reasoning once; twenty hand-copied ones cannot, and the next
 * accessor silently widens instead.
 *
 * HOW TO USE THESE. Spread, then add what the accessor needs:
 *
 *     .select({ ...issueIdentityColumns, statusName: projectStatuses.name })
 *
 * Spreading (rather than a wrapper function that builds the query) is deliberate: drizzle
 * infers the row type from the object literal, so the caller keeps an exact, checked return
 * type and the extraction costs nothing at the type level. A base-repository class or a
 * generic query builder would erase that.
 *
 * WHAT DOES NOT BELONG HERE: a projection with one caller. Every constant below has at
 * least two real production callers, and `projections-shared-usage.test.ts` fails if that
 * stops being true — a shared helper with no second caller is the #591 failure mode, not an
 * improvement. That rule is also why the `rows[0] ?? null` tail of a `.limit(1)` lookup is
 * NOT here: it occurs 75 times in this layer, migrating all 75 is out of proportion to this
 * ticket, and a helper applied at 5 of them would be a fresh partial migration to disclose
 * rather than a win. It is filed as follow-up instead.
 */

/**
 * How a ticket identifies itself: the row id, the human `#N`, and the title. The prefix of
 * nearly every issue projection in the layer.
 */
export const issueIdentityColumns = {
  id: issues.id,
  issueNumber: issues.issueNumber,
  title: issues.title,
};

/** Identity plus the body — for anything that shows or feeds an agent the ticket text. */
export const issueTextColumns = {
  ...issueIdentityColumns,
  description: issues.description,
};

/** Identity plus priority — for the ordering/triage views (board status, sprint capacity). */
export const issueTriageColumns = {
  ...issueIdentityColumns,
  priority: issues.priority,
};

/**
 * A session's run lifecycle: which workspace, what state, and the window it ran in.
 *
 * Deliberately WITHOUT `stats` and `exitCode`. `sessions.stats` is a JSON blob measured at
 * ~2.9 MB on the dev project (see the note in `project-activity.repository.ts`), so pulling
 * it in by default is the mistake this projection exists to make visible — add it
 * explicitly where it is actually parsed.
 */
export const sessionLifecycleColumns = {
  id: sessions.id,
  workspaceId: sessions.workspaceId,
  status: sessions.status,
  startedAt: sessions.startedAt,
  endedAt: sessions.endedAt,
};

/** A dependency edge's own columns, without any joined issue detail. */
export const issueDependencyColumns = {
  id: issueDependencies.id,
  issueId: issueDependencies.issueId,
  dependsOnId: issueDependencies.dependsOnId,
  type: issueDependencies.type,
};

/** The id -> name pair every status-name lookup selects. */
export const projectStatusIdName = {
  id: projectStatuses.id,
  name: projectStatuses.name,
};

/** A preference row, for the accessors that read a whole group of keys at once. */
export const preferenceKeyValueColumns = {
  key: preferences.key,
  value: preferences.value,
};
