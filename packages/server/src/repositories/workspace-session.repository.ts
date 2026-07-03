import { issues, sessions, sessionMessages, workspaces } from "@agentic-kanban/shared/schema";
import { sanitizeUtf8 } from "@agentic-kanban/shared/lib/sanitize-utf8";
import { setWorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getIssueTitleAndDescription(
  issueId: string,
  database: Database = db,
): Promise<{ title: string; description: string | null } | null> {
  const rows = await database
    .select({ title: issues.title, description: issues.description })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getSessionsForWorkspace(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));
}

export async function applyPlanImplementWorkspaceUpdate(
  workspaceId: string,
  values: {
    claudeProfile: string | null;
    agentCommand: string | null;
    provider: string;
    now: string;
  },
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, workspaceId, "active", {
    now: values.now,
    set: {
      pendingPlanPath: null,
      claudeProfile: values.claudeProfile,
      agentCommand: values.agentCommand,
      provider: values.provider,
    },
  });
}

export async function applyPlanRejectWorkspaceUpdate(
  workspaceId: string,
  values: {
    claudeProfile: string | null;
    agentCommand: string | null;
    provider: string;
    now: string;
  },
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, workspaceId, "active", {
    now: values.now,
    set: {
      pendingPlanPath: null,
      planMode: true,
      claudeProfile: values.claudeProfile,
      agentCommand: values.agentCommand,
      provider: values.provider,
    },
  });
}

export async function insertPlanGateAuditMessage(
  sessionId: string,
  data: string,
  database: Database = db,
): Promise<void> {
  await database.insert(sessionMessages).values({
    sessionId,
    type: "stdout",
    data: sanitizeUtf8(data),
    exitCode: null,
  });
}
