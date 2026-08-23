// #544. `finalizePlanModeExit` resolved the harness with a hand-rolled
// `codex ? codex : copilot ? copilot : claude` ladder, which silently mapped `pi` to
// `claude` — so a Pi plan run read CLAUDE's `plan_auto_continue` and could auto-continue
// (or park) against a setting the operator never touched for Pi.
//
// The startup reconciler used `narrowProviderName` and got it right, so the live path and
// the recovery path could reach opposite decisions for the same workspace. Both now share
// this implementation; this pins the resolution so the ladder cannot come back.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preferences, projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { finalizePlanModeExit } from "../services/session-manager/plan-mode-exit.js";
import type { Database } from "../db/index.js";
import type { ProviderId } from "../services/agent-provider/types.js";


const PLAN = "<!-- PLAN:START -->\n# Plan\n- step one\n<!-- PLAN:END -->";

async function seed(db: Database, harnessKey: string | null) {
  const projectId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
  const statusId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "/tmp/p", defaultBranch: "master", createdAt: now, updatedAt: now } as never);
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now } as never);
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1, priority: "medium", sortOrder: 0, createdAt: now, updatedAt: now } as never);
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1", workingDir: mkdtempSync(join(tmpdir(), "plan-harness-")),
    isDirect: false, status: "active", planMode: true, createdAt: now, updatedAt: now,
  } as never);
  // Auto-continue OFF for pi, ON for claude — so the two resolutions are distinguishable
  // by outcome rather than by reading an internal.
  // onConflictDoNothing: preference keys are global, and one test seeds twice.
  await db.insert(preferences).values([
    { key: "harness.claude.plan_auto_continue", value: "true" },
    { key: "harness.pi.plan_auto_continue", value: "false" },
    ...(harnessKey ? [{ key: harnessKey, value: "true" }] : []),
  ] as never).onConflictDoNothing();
  return { projectId, workspaceId };
}

describe("finalizePlanModeExit — harness resolution (#544)", () => {
  let db: Database;
  beforeEach(() => { db = createTestDb().db as unknown as Database; });

  it("reads PI's plan_auto_continue for a pi plan run, not Claude's", async () => {
    const { projectId, workspaceId } = await seed(db, null);
    const startSession = vi.fn(async () => "sess");
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));

    await finalizePlanModeExit(workspaceId, 0, PLAN,
      { agentCommand: undefined, agentArgs: undefined, permissionPromptTool: undefined,
        provider: "pi", profile: { provider: "pi", name: "local" } },
      { db, workspaceWorkingDir: ws.workingDir, projectId, startSession });

    // pi -> auto-continue false -> park for approval. Under the old ladder pi resolved to
    // claude, whose flag is true here, so this would have relaunched instead.
    expect(startSession).not.toHaveBeenCalled();
    const [after] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(after.status).toBe("awaiting-plan-approval");
    expect(after.planMode).toBe(false);
  });

  it("still resolves claude (including the legacy claude-code id) to claude", async () => {
    // `ProviderId` names only the legacy "claude-code" spelling, but every workspace row
    // stores the modern "claude" and `narrowProviderName` accepts both — so the value this
    // loop feeds is wider than `PlanModeExitRelaunch.provider` declares. The cast is the
    // test recording that gap rather than hiding it; widening the production type is #808's
    // reported follow-up, not a change a test may make.
    for (const provider of ["claude", "claude-code"] as unknown as readonly ProviderId[]) {
      const { projectId, workspaceId } = await seed(db, null);
      const startSession = vi.fn(async () => "sess");
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
      await finalizePlanModeExit(workspaceId, 0, PLAN,
        { agentCommand: undefined, agentArgs: undefined, permissionPromptTool: undefined,
          provider, profile: undefined },
        { db, workspaceWorkingDir: ws.workingDir, projectId, startSession });
      expect(startSession, `provider=${provider}`).toHaveBeenCalledOnce();
    }
  });
});
