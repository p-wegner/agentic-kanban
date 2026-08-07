import { projects } from "@agentic-kanban/shared/schema";
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
  kind: "plugin-gate" | "agent-question" | "tool-approval";
  projectId: string;
  projectName: string;
  title: string;
  detail: string | null;
  /** Client-side navigation hints — which surface resolves this item. */
  link: {
    view: "plugin-views" | "butler" | "board";
    pluginId?: string;
    loopName?: string;
    workspaceId?: string;
    issueNumber?: number | null;
  };
  createdAt: string | null;
}

export async function listInbox(database: Database = db): Promise<{ items: InboxItem[] }> {
  const items: InboxItem[] = [];
  const projectRows = await database
    .select({ id: projects.id, name: projects.name })
    .from(projects);
  const pluginService = getPluginService(database);

  for (const project of projectRows) {
    // Plugin gates: same visibility rule as the gate card — a gate with round tickets
    // still open is not actionable yet.
    try {
      const surface = await pluginService.listProjectSurface(project.id);
      for (const loop of surface.loops) {
        if (!loop.gate || loop.openTickets > 0) continue;
        items.push({
          kind: "plugin-gate",
          projectId: project.id,
          projectName: project.name,
          title: loop.gate.question,
          detail: `${loop.pluginName} — ${loop.label}`
            + (loop.gateRecommendation ? ` · Butler recommends: ${loop.gateRecommendation.actionId}` : ""),
          link: { view: "plugin-views", pluginId: loop.pluginId, loopName: loop.name },
          createdAt: loop.lastAdvanceAt,
        });
      }
    } catch (err) {
      console.warn(`[inbox] plugin surface failed for project ${project.id}:`, err instanceof Error ? err.message : String(err));
    }

    // Agent questions (cached per project by the listing service).
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
