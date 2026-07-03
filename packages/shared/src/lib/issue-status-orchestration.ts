/**
 * Issue-status orchestration seams — the DB-coupled side effects that BOTH the
 * server issue service and the MCP move_issue/update_issue tools must run on an
 * issue status change, factored into one place so the two entry paths can no
 * longer drift (arch-review #974). Continues the `findOpenUnmergedWorkspace` seam
 * pattern: parameterised over a Drizzle handle (`WorkflowDb`), so the server
 * `Database` and the MCP `ToolDb` — both `LibSQLDatabase<typeof schema>` — pass it
 * unchanged.
 *
 * Pure status writing stays in `workflow-engine/status-transition.ts`
 * (`transitionIssueStatus`, the #953 single write authority); the webhook wire
 * shape + URL validation stay pure in `outbound-webhook.ts`. This module is the
 * db-coupled glue that reads/queries and fires.
 */
import { and, eq, ne } from "drizzle-orm";
import * as schema from "../schema/index.js";
import type { WorkflowDb } from "./workflow-engine/types.js";
import { buildIssueStatusPayload, fireWebhook, validateWebhookUrl } from "./outbound-webhook.js";

/**
 * The AK-535 terminal-move guard SEAM: is there an open, non-direct, unmerged
 * workspace for this issue? Direct workspaces (`isDirect=true`) commit straight to
 * master — no branch to merge — so they are excluded. Moving an issue to a
 * terminal status (Done/Cancelled) while such a workspace is open strands the
 * branch and causes silent merge loss. Single source shared by the server issue
 * service, the CLI, and the MCP move_issue/update_issue tools so the guard query
 * can never drift (was forked as server `findOpenUnmergedWorkspace` + MCP
 * `checkOpenUnmergedWorkspace`).
 */
export async function findOpenUnmergedWorkspace(
  db: WorkflowDb,
  issueId: string,
): Promise<{ id: string; branch: string } | null> {
  const rows = await db
    .select({ id: schema.workspaces.id, branch: schema.workspaces.branch })
    .from(schema.workspaces)
    .where(and(
      eq(schema.workspaces.issueId, issueId),
      ne(schema.workspaces.status, "closed"),
      eq(schema.workspaces.isDirect, false),
    ))
    .limit(1);
  return rows[0] ?? null;
}

/** The preference key that holds a project's outbound webhook URL. */
export function outboundWebhookPrefKey(projectId: string): string {
  return `outbound_webhook_url_${projectId}`;
}

/**
 * Read the `outbound_webhook_url_<projectId>` preference and return the validated
 * loopback URL, or null when unset/invalid. Best-effort — a read failure resolves
 * to null. Single source of the pref-key derivation + validation shared by the
 * MCP tools and the server webhook sender (all three previously inlined it).
 */
export async function resolveOutboundWebhookUrl(
  db: WorkflowDb,
  projectId: string,
): Promise<string | null> {
  const raw = await db
    .select({ value: schema.preferences.value })
    .from(schema.preferences)
    .where(eq(schema.preferences.key, outboundWebhookPrefKey(projectId)))
    .limit(1)
    .then((rows) => rows[0]?.value ?? null)
    .catch(() => null);
  return validateWebhookUrl(raw);
}

/**
 * Resolve the configured webhook URL and fire an `issue.status_changed` event
 * (fire-and-forget, best-effort). Used by the MCP move_issue/update_issue tools,
 * which have a raw Drizzle handle rather than the server's injected
 * `WebhookSender`.
 */
export async function fireIssueStatusWebhook(
  db: WorkflowDb,
  args: {
    issueId: string;
    issueNumber: number | null;
    title: string;
    projectId: string;
    newStatusId: string;
    newStatusName: string | null;
    statusChangedAt: string;
  },
): Promise<void> {
  const url = await resolveOutboundWebhookUrl(db, args.projectId);
  if (url) fireWebhook(url, buildIssueStatusPayload(args));
}
