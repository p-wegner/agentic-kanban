import { issues, plugins, preferences, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { ACTIVE_WORKSPACE_STATUSES } from "@agentic-kanban/shared/lib/workspace-activity-state";

export type PluginRow = typeof plugins.$inferSelect;

export async function listPluginRows(database: Database = db): Promise<PluginRow[]> {
  return database.select().from(plugins).orderBy(plugins.name);
}

export async function getPluginRowById(id: string, database: Database = db): Promise<PluginRow | null> {
  const rows = await database.select().from(plugins).where(eq(plugins.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getPluginRowBySlug(pluginId: string, database: Database = db): Promise<PluginRow | null> {
  const rows = await database.select().from(plugins).where(eq(plugins.pluginId, pluginId)).limit(1);
  return rows[0] ?? null;
}

/** Insert-or-update keyed on the manifest slug (`plugin_id` unique index). */
export async function upsertPluginRow(
  values: Omit<PluginRow, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string },
  database: Database = db,
): Promise<PluginRow> {
  const now = new Date().toISOString();
  await database
    .insert(plugins)
    .values({ ...values, createdAt: values.createdAt ?? now, updatedAt: values.updatedAt ?? now })
    .onConflictDoUpdate({
      target: plugins.pluginId,
      set: {
        name: values.name,
        sourceUrl: values.sourceUrl,
        localPath: values.localPath,
        version: values.version,
        manifestJson: values.manifestJson,
        updatedAt: values.updatedAt ?? now,
      },
    });
  const row = await getPluginRowBySlug(values.pluginId, database);
  if (!row) throw new Error(`plugin upsert for "${values.pluginId}" did not persist`);
  return row;
}

export async function deletePluginRow(id: string, database: Database = db): Promise<void> {
  await database.delete(plugins).where(eq(plugins.id, id));
}

/** Escape the LIKE metacharacters (`\`, `%`, `_`) so a prefix matches itself and nothing else. */
export function escapeLikeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface LoopIssueRow {
  id: string;
  issueNumber: number | null;
  externalKey: string;
  statusName: string;
  /** This ticket has at least one workspace that is not closed (#413 phantom detection). */
  hasLiveWorkspace: boolean;
  /** This ticket has ever had a workspace at all — separates "ran and ended" from "queued". */
  hasAnyWorkspace: boolean;
}

/**
 * Every issue in a project whose `external_key` marks it as a plugin-loop unit.
 *
 * The loop engine dedupes against this: a unit the planner still reports but that
 * already has a ticket must NOT be re-ticketed, and a unit whose ticket reached a
 * terminal status is what lets the planner's next round move on. Scoped by the
 * `plugin-loop:<slug>:<loop>:` prefix so one project can run several loops.
 *
 * The prefix is matched as a LITERAL (#250): a loop named `extract_v2` puts a `_` — a
 * single-character LIKE wildcard — into the prefix, so an unescaped match counted a sibling
 * loop's tickets and the monitor's `openTickets > 0` gate then blocked or released the wrong
 * loop. Every wildcard in the prefix is escaped and the pattern carries an explicit
 * `ESCAPE '\'`.
 */
export async function listPluginLoopIssues(
  projectId: string,
  keyPrefix: string,
  database: Database = db,
): Promise<LoopIssueRow[]> {
  const pattern = `${escapeLikeLiteral(keyPrefix)}%`;
  // #479 — "not closed" is NOT the same claim as "live". A workspace whose agent exited with
  // no commits sits at `idle` (or `error`/`ready_for_merge`/`blocked`) forever — none of those
  // is "closed", so the old `status != 'closed'` test called it live and `stranded` came back
  // false on the exact ticket it exists to catch. `ACTIVE_WORKSPACE_STATUSES` is the one shared
  // definition of "an agent is actually working this" (workspace-activity-state.ts); every
  // other status, including `idle`, means nothing is driving the ticket right now.
  const liveStatusList = sql.join([...ACTIVE_WORKSPACE_STATUSES].map((s) => sql`${s}`), sql`, `);
  const rows = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      externalKey: issues.externalKey,
      statusName: projectStatuses.name,
      // #413/#397 — an open loop ticket with no LIVE workspace but a dead one behind it is
      // the phantom shape: the work ran, the workspace closed, and the ticket stayed open,
      // so the loop's own pane says "round in progress" about something nothing is driving.
      // Correlated EXISTS rather than two more round trips; these rows already load per loop.
      hasLiveWorkspace: sql<boolean>`EXISTS (
        SELECT 1 FROM ${workspaces} AS live
        WHERE live.issue_id = ${issues.id} AND live.status IN (${liveStatusList})
      )`,
      hasAnyWorkspace: sql<boolean>`EXISTS (
        SELECT 1 FROM ${workspaces} AS any_ws WHERE any_ws.issue_id = ${issues.id}
      )`,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(eq(issues.projectId, projectId), sql`${issues.externalKey} LIKE ${pattern} ESCAPE '\\'`));
  return rows.flatMap((row) =>
    row.externalKey
      ? [{
          ...row,
          externalKey: row.externalKey,
          // SQLite returns 0/1 for EXISTS; normalise so consumers can trust the type.
          hasLiveWorkspace: Boolean(row.hasLiveWorkspace),
          hasAnyWorkspace: Boolean(row.hasAnyWorkspace),
        }]
      : [],
  );
}

/** One issue's loop-hook identity (#297/#298): its external key + project. */
export async function getIssueExternalKeyInfo(
  issueId: string,
  database: Database = db,
): Promise<{ externalKey: string | null; projectId: string } | null> {
  const rows = await database
    .select({ externalKey: issues.externalKey, projectId: issues.projectId })
    .from(issues).where(eq(issues.id, issueId)).limit(1);
  return rows[0] ?? null;
}

export interface LoopUnmergedWorkspaceRow {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueStatusName: string;
  /** The ticket's full loop unit key (`plugin-loop:<slug>:<loop>:<unitId>`) — lets the
   *  service correlate this row with the CURRENT gate's unit (#326). */
  externalKey: string | null;
  /** `workspaces.status` — the service classifies the stall from this vs `issueStatusName` (#363). */
  workspaceStatus: string;
  /**
   * `workspaces.ready_for_merge`. Deliberately surfaced beside `workspaceStatus`: a live row was
   * measured with `status: "ready_for_merge"` and `readyForMerge: false` at the same time (#363),
   * so a consumer that reads only one of the two gets the opposite answer. The service reports
   * the contradiction rather than picking a winner.
   */
  workspaceReadyForMerge: boolean;
  /** When the workspace row last changed — how long the stall has been held. */
  workspaceUpdatedAt: string;
  /**
   * Whether ANOTHER workspace on the same issue already merged (`mergedAt IS NOT NULL`) — i.e. this
   * unit's work is already on the base branch and THIS row is a leftover (#337).
   *
   * Why it has to be selected here rather than decided in the service: the query keys only on
   * `status != 'closed' AND mergedAt IS NULL`, which is true of an after-merge REVIEW workspace and
   * of any second workspace on the issue. MEASURED on kassenbuch round 3: for ~5 minutes after a
   * step landed, `awaitingMerge` pointed at such a row and the loop card rendered a literal "Merge
   * now" button for a unit whose merge commit was already on master — and "click Merge now" is
   * exactly what the operator documentation says to do in that state. The operator checked
   * `git log` first and did nothing; a less careful one, or the butler, would have poked it.
   *
   * Deliberately an EXISTS over the workspaces table, not a git call: `loopStatuses` runs on every
   * plugin-surface read, and the classifier is DB-only by design (#359).
   */
  issueHasMergedWorkspace: boolean;
}

/**
 * Loop tickets that are finished-or-parked but whose workspace has not landed (#299/#336/#363).
 *
 * This is the loop's silent-stall state: the planner reads the MAIN checkout, so until the merge
 * lands it keeps reporting the step as not-generated — and the external-key dedupe turns every
 * re-advance into a no-op.
 *
 * ── Why the issue-status filter is not enough on its own (#336/#363) ──
 *
 * The original WHERE required `projectStatuses.name IN ('In Review','AI Reviewed','Done')`, i.e. it
 * assumed a stalled workspace always has a ticket whose builder is finished BY ISSUE STATUS. Two
 * measured stalls are invisible to that:
 *
 * - **#336 variant 1** — the exit workflow never ran (crash, reboot, SIGTERM in the agent's exit
 *   window). The startup sweep sets the WORKSPACE to `ready_for_merge` but nothing transitions the
 *   issue, so it sits In Progress with completed work on a branch and master never advances.
 * - **#363** — issue #7 of a live pipeline: workspace `ready_for_merge` since 20:18:13Z, issue
 *   `In Progress` and never advanced, held 12+ minutes. `awaitingMerge` was null the whole time,
 *   so the ONE indicator built to catch a silent loop stall was blind to the stall.
 *
 * Both are "finished by WORKSPACE status while the issue never left In Progress" — a combination
 * the old query could not represent. So the workspace's own terminal-ish statuses are now an
 * ALTERNATIVE to the issue-status filter, not an additional requirement.
 *
 * The row still says which of the two matched (`workspaceStatus` vs `issueStatusName`), because
 * the two states need DIFFERENT affordances: #299's is safe to one-click merge, and #363's branch
 * turned out to have zero commits — offering "Merge now" there would be a fix built on the
 * assumption that parked means finished. Classification lives in the service.
 *
 * ── The CLOSED-and-never-merged arm (#445) ──
 *
 * `status != 'closed'` was an additional requirement for years, and it hid its own stall shape.
 * MEASURED on eventhub (2026-08-13): 9 of 28 open `requirement-extraction` tickets sat In Review
 * since 2026-08-05 with their ONE workspace `closed`, `mergedAt: null`, `readyForMerge: false`.
 * A loop only replans once its round's tickets are all terminal, so those nine are a permanent
 * brake — and being outside this query, they produced no stall, no inbox item and no nudge.
 *
 * So a CLOSED workspace with no merge whose ISSUE is still non-terminal is now returned too. The
 * terminal-status exclusion is what keeps it narrow: a closed unmerged workspace under a Done or
 * Cancelled ticket is ordinary history (a superseded workspace, a cancelled unit) and blocks
 * nothing. The service gives this arm its own reason and `mergeSafe: false` — the branch may still
 * exist and be landable, or the work may be genuinely lost, and those need different remedies.
 */
const WORKSPACE_PARKED_STATUSES = ["ready_for_merge"] as const;
/** Issue statuses that make a closed-unmerged workspace ordinary history rather than a stall. */
const TERMINAL_ISSUE_STATUSES = ["Done", "Cancelled"] as const;

export async function listPluginLoopUnmergedWorkspaces(
  projectId: string,
  keyPrefix: string,
  database: Database = db,
): Promise<LoopUnmergedWorkspaceRow[]> {
  const pattern = `${escapeLikeLiteral(keyPrefix)}%`;
  const rows = await database
    .select({
      workspaceId: workspaces.id,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      issueStatusName: projectStatuses.name,
      externalKey: issues.externalKey,
      workspaceStatus: workspaces.status,
      workspaceReadyForMerge: workspaces.readyForMerge,
      workspaceUpdatedAt: workspaces.updatedAt,
      // #337 — does the issue already have a LANDED workspace? Correlated EXISTS rather than a
      // second round trip, and `sibling.id != workspaces.id` so a row can never vouch for itself
      // (it cannot anyway, given the `mergedAt IS NULL` filter, but the join must not depend on
      // that filter staying).
      issueHasMergedWorkspace: sql<boolean>`EXISTS (
        SELECT 1 FROM ${workspaces} AS sibling
        WHERE sibling.issue_id = ${issues.id}
          AND sibling.merged_at IS NOT NULL
          AND sibling.id != ${workspaces.id}
      )`,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(
      eq(issues.projectId, projectId),
      sql`${issues.externalKey} LIKE ${pattern} ESCAPE '\\'`,
      sql`${workspaces.mergedAt} IS NULL`,
      sql`(
        (${workspaces.status} != 'closed'
          AND (${projectStatuses.name} IN ('In Review', 'AI Reviewed', 'Done')
            OR ${workspaces.status} IN ${WORKSPACE_PARKED_STATUSES}))
        OR
        (${workspaces.status} = 'closed'
          AND ${projectStatuses.name} NOT IN ${TERMINAL_ISSUE_STATUSES})
      )`,
    ));
  return rows;
}

/**
 * The git coordinates of one stalled workspace, for the autoLand recovery's commits-ahead
 * re-check (#444). Deliberately three columns: the recovery must never land on a status, only on
 * a verified commit count, and nothing else about the row informs that decision.
 */
export async function getWorkspaceGitCoordinates(
  workspaceId: string,
  database: Database = db,
): Promise<{ id: string; workingDir: string | null; baseBranch: string | null } | null> {
  const rows = await database
    .select({ id: workspaces.id, workingDir: workspaces.workingDir, baseBranch: workspaces.baseBranch })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Session stats of every session that ran against a loop's unit tickets (#294).
 * The join is the same shape as the cost-over-time analytics: sessions →
 * workspaces → issues, narrowed to this loop's `external_key` prefix. The
 * caller folds `stats.totalCostUsd` / token counts — parsing the JSON belongs
 * in the service, not the query.
 */
export async function listPluginLoopSessionStats(
  projectId: string,
  keyPrefix: string,
  database: Database = db,
): Promise<Array<{ externalKey: string; stats: string | null }>> {
  const pattern = `${escapeLikeLiteral(keyPrefix)}%`;
  const rows = await database
    .select({ externalKey: issues.externalKey, stats: sessions.stats })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(eq(issues.projectId, projectId), sql`${issues.externalKey} LIKE ${pattern} ESCAPE '\\'`));
  return rows.flatMap((row) => (row.externalKey ? [{ externalKey: row.externalKey, stats: row.stats }] : []));
}

/**
 * All `plugin_enabled_*` preference rows. Callers pair this with the pure
 * `isPluginEnabledPreferenceKey` matcher and their own projectId filter — the
 * LIKE is just a coarse server-side narrowing.
 */
export async function listPluginEnabledPreferences(
  database: Database = db,
): Promise<Array<{ key: string; value: string }>> {
  return database
    .select({ key: preferences.key, value: preferences.value })
    .from(preferences)
    .where(like(preferences.key, "plugin_enabled_%"));
}

/**
 * The project's "In Progress" lane id, or null when it has none.
 *
 * Lives here rather than in the service because `services-bypass-repositories` (dependency-cruiser)
 * is the rule that keeps drizzle out of the service layer. Used by the loop's direct-start path to
 * measure WIP through `countActiveWip` (#351).
 */
export async function getInProgressStatusId(
  projectId: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database.select({ id: projectStatuses.id }).from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "In Progress")))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Is `pluginSlug` enabled for `projectId`?
 *
 * The canonical read of `plugin_enabled_<slug>_<projectId>`, and deliberately the ONLY place
 * that compares that preference against its truthy literal — the #947 polarity ratchet
 * baselines this one site for exactly that reason. The raw comparison had been copy-pasted
 * across call sites, and each copy re-decided the default independently, so a missing pref
 * could mean "disabled" in one place and "enabled" in another. Enablement is opt-in: an
 * absent preference means NOT enabled, and that decision now lives here once.
 */
export async function isPluginEnabledForProject(
  pluginSlug: string,
  projectId: string,
  database: Database = db,
): Promise<boolean> {
  const rows = await database.select({ value: preferences.value }).from(preferences)
    .where(eq(preferences.key, `plugin_enabled_${pluginSlug}_${projectId}`))
    .limit(1);
  return rows[0]?.value === "true";
}
