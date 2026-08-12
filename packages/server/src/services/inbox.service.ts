import { projects } from "@agentic-kanban/shared/schema";
import { isNull } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { listPendingApprovals } from "./approvals.js";
import { listPendingQuestionsForProject } from "./agent-questions/listing.js";
import { getPluginService } from "./plugin.service.js";

/**
 * Cross-project "Waiting on you" inbox (#302) — the union of every decision that is
 * blocked on a human, across ALL projects: pending plugin-loop gates, unanswered agent
 * questions, and un-decided tool approvals. Nothing like this existed at any layer:
 * each of those was project-scoped and lived in its own pane, so a gate on a project
 * whose tab wasn't open was invisible once its 4-second toast faded.
 *
 * Read-only aggregation — every item carries what a client needs to DEEP-LINK to the
 * surface that can actually resolve it. Plan approvals (spec-planning workspaces) are
 * a known follow-up; they need a cheap cross-project "planning awaiting approval"
 * query that doesn't exist yet.
 */

export interface InboxItem {
  /**
   * `plugin-merge` (#440) is a loop whose builder finished but whose merge never
   * landed. It waits on a human exactly as a gate does — nothing advances the loop
   * until someone lands or discards it — but it was omitted here for months while
   * `list_plugin_gates` reported it, so the two surfaces disagreed on what
   * "waiting on you" means.
   */
  kind: "plugin-gate" | "plugin-merge" | "agent-question" | "tool-approval";
  projectId: string;
  projectName: string;
  title: string;
  detail: string | null;
  /** Client-side navigation hints — which surface resolves this item. */
  link: {
    view: "plugin-views" | "butler" | "board";
    pluginId?: string;
    pluginSlug?: string;
    loopName?: string;
    workspaceId?: string;
    issueNumber?: number | null;
  };
  createdAt: string | null;
}

/** The slice of a loop status the inbox actually reads off the bulk plugin surface. */
type InboxLoopStatus = Awaited<ReturnType<ReturnType<typeof getPluginService>["listLoopSurfacesForProjects"]>> extends Map<string, Array<infer L>> ? L : never;

/**
 * Plugin-gate items for ONE project, from the pre-fetched bulk loop surface.
 * Gates use the same visibility rule as the gate card — a gate with round tickets
 * still open is not actionable yet.
 */
function collectGateItems(
  project: { id: string; name: string },
  loops: InboxLoopStatus[],
): InboxItem[] {
  const items: InboxItem[] = [];
  for (const loop of loops) {
    // A finished-but-unlanded ticket (#440). Reported independently of the gate check
    // below: the two are different waits and a loop can be in either.
    const awaiting = loop.awaitingMerge;
    if (awaiting) {
      items.push({
        kind: "plugin-merge",
        projectId: project.id,
        projectName: project.name,
        title: awaiting.issueNumber ? `#${awaiting.issueNumber} ${awaiting.issueTitle}` : awaiting.issueTitle,
        // `mergeSafe: false` (#363) must never read as "land this" — the measured
        // instance had zero commits on its branch, so merging would close the unit
        // without its artifacts.
        detail: `${loop.pluginName} — ${loop.label} · `
          + (awaiting.mergeSafe === false
            ? `DO NOT merge: ${awaiting.detail ?? awaiting.reason ?? "branch has nothing to land"}`
            : `finished, waiting to land${awaiting.reason ? ` (${awaiting.reason})` : ""}`),
        link: { view: "board", workspaceId: awaiting.workspaceId, issueNumber: awaiting.issueNumber },
        createdAt: loop.lastAdvanceAt ?? null,
      });
    }
    if (!loop.gate || loop.openTickets > 0) continue;
    items.push({
      kind: "plugin-gate",
      projectId: project.id,
      projectName: project.name,
      title: loop.gate.question,
      detail: `${loop.pluginName} — ${loop.label}`
        + (loop.gateRecommendation ? ` · Butler recommends: ${loop.gateRecommendation.actionId}` : ""),
      link: { view: "plugin-views", pluginId: loop.pluginId, pluginSlug: loop.pluginSlug, loopName: loop.name },
      // The gate's own birth, NOT `lastAdvanceAt` — the monitor re-plans a gated loop
      // every cycle, so `lastAdvanceAt` keeps moving while the human has not acted and
      // an hour-old decision showed up here as if it had just arrived.
      createdAt: loop.gateSince ?? loop.lastAdvanceAt,
    });
  }
  return items;
}

/**
 * Agent-question items for ONE project (cached per project by the listing service).
 * try/catch is per-project on purpose: one project's broken listing must not empty
 * the whole inbox.
 */
async function collectQuestionItems(
  project: { id: string; name: string },
  database: Database,
): Promise<InboxItem[]> {
  const items: InboxItem[] = [];
  try {
    for (const set of await listPendingQuestionsForProject(project.id, database)) {
      if (set.staleness) continue; // likely no longer actionable — not "waiting on you"
      items.push({
        kind: "agent-question",
        projectId: project.id,
        projectName: project.name,
        title: set.questions[0]?.question ?? "Agent question",
        detail: set.issueNumber != null ? `#${set.issueNumber}: ${set.issueTitle}` : set.issueTitle ?? null,
        link: { view: "butler", workspaceId: set.workspaceId, issueNumber: set.issueNumber ?? null },
        createdAt: set.askedAt ?? null,
      });
    }
  } catch (err) {
    console.warn(`[inbox] agent questions failed for project ${project.id}:`, err instanceof Error ? err.message : String(err));
  }
  return items;
}

export async function listInbox(database: Database = db): Promise<{ items: InboxItem[] }> {
  // Archived projects are excluded (2026-08-11 perf audit) — also a correctness fix:
  // an archived project's gates surfaced here with deep links into a project the UI
  // can no longer navigate to, and its whole plugin/question scan was wasted work.
  const projectRows = await database
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(isNull(projects.archivedAt));
  const pluginService = getPluginService(database);

  // #348: this used to be `for (const project of projectRows) { await ...; await ...; }`
  // — strictly serial, so the cost was O(projects x plugins x loops x ~8 awaits) with
  // every round-trip's latency stacking, on an endpoint the UI POLLS. There is no
  // ordering dependency between the two sources or between projects: everything is
  // sorted by createdAt at the end. The plugin-gate source is now ONE bulk read
  // (2026-08-11 perf audit — plugin rows / manifest parses / enabled-pref scans are
  // hoisted out of the per-project loop and the cost rollup is skipped); the
  // agent-question source still fans out per project. The two run concurrently.
  const surfacesPromise = pluginService
    .listLoopSurfacesForProjects(projectRows.map((p) => p.id))
    .catch((err: unknown) => {
      console.warn(`[inbox] plugin loop surfaces failed:`, err instanceof Error ? err.message : String(err));
      return new Map<string, InboxLoopStatus[]>();
    });
  const [loopSurfaces, questionItems] = await Promise.all([
    surfacesPromise,
    Promise.all(projectRows.map((project) => collectQuestionItems(project, database))),
  ]);
  const items: InboxItem[] = questionItems.flat();
  for (const project of projectRows) {
    items.push(...collectGateItems(project, loopSurfaces.get(project.id) ?? []));
  }

  // Tool approvals are in-memory and already carry their projectId.
  const nameById = new Map(projectRows.map((p) => [p.id, p.name]));
  for (const approval of listPendingApprovals()) {
    items.push({
      kind: "tool-approval",
      projectId: approval.projectId ?? "",
      projectName: approval.projectId ? (nameById.get(approval.projectId) ?? "?") : "?",
      title: `Tool approval: ${approval.toolName}`,
      detail: approval.workspaceId ? `workspace ${approval.workspaceId}` : null,
      link: { view: "board", workspaceId: approval.workspaceId },
      createdAt: new Date(approval.createdAt).toISOString(),
    });
  }

  items.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return { items };
}
