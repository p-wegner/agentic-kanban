/**
 * Integration coverage for the session-exit usage-limit rotation path
 * (`handleUsageLimitExit` in exit-workflow.ts), which collapsed the formerly
 * duplicated Codex-license and Claude-subscription branches into one
 * config-driven implementation (`USAGE_LIMIT_PROVIDERS`).
 *
 * These tests lock in the WIRING the refactor must preserve — the part that the
 * pure `rate-limit-exit-decision` unit tests do not cover:
 *   1. The right provider config is selected from the session's stats signature.
 *   2. A builder session on a freshly-rotated profile is relaunched with the
 *      provider-correct `provider` / `profile` / `claudeProfile` shape, the
 *      workspace flipped back to "active", and a butler event emitted.
 *   3. When the ring cannot rotate (no fresh profile), the workspace is left
 *      "blocked" and NOT relaunched.
 *
 * The ring rotation functions themselves are mocked — their internals are tested
 * in codex-license-ring / claude-subscription-ring suites; here we only assert
 * that exit-workflow dispatches to and relaunches off them correctly.
 */

// Mock modules exit-workflow.ts loads at import time + the rotation collaborators.
vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/butler-event-feed.js", () => ({ emitButlerSystemEvent: vi.fn() }));
vi.mock("../services/agent-settings.service.js", () => ({
  isMockProfile: vi.fn(() => false),
  toExecutorProvider: vi.fn((p: string) => p),
  MOCK_AGENT_COMMAND: "mock",
}));

// Stats signatures: a session whose stats contains the provider marker is "limited".
vi.mock("../services/codex-rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/codex-rate-limit.js")>()),
  isCodexUsageLimitStats: vi.fn((stats: string | null | undefined) => !!stats?.includes("codex-limit")),
}));
vi.mock("../services/claude-rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/claude-rate-limit.js")>()),
  isClaudeUsageLimitStats: vi.fn((stats: string | null | undefined) => !!stats?.includes("claude-limit")),
}));

const rotateCodexLicense = vi.fn();
const rotateClaudeSubscription = vi.fn();
vi.mock("../services/codex-license-ring.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/codex-license-ring.js")>()),
  rotateCodexLicense: (...args: unknown[]) => rotateCodexLicense(...args),
}));
vi.mock("../services/claude-subscription-ring.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/claude-subscription-ring.js")>()),
  rotateClaudeSubscription: (...args: unknown[]) => rotateClaudeSubscription(...args),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { emitButlerSystemEvent } from "../services/butler-event-feed.js";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkflowEngine } from "../startup/exit-workflow.js";

function makeBoardEvents() {
  return { broadcast: vi.fn(), broadcastActivity: vi.fn() };
}
function makeSessionManager() {
  return { startSession: vi.fn(async () => randomUUID()) };
}

/** Seed a builder workspace whose latest session hit a provider usage limit. */
async function seedRateLimitedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  statsMarker: string,
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inProgressStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inProgressStatusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 700, title: "Rate-limited builder", priority: "medium", sortOrder: 0,
    description: "Implement the thing.", statusId: inProgressStatusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-700-test",
    workingDir: "/repo/.worktrees/ak-700-test", baseBranch: "master",
    isDirect: false, status: "active", readyForMerge: false,
    provider: "codex", createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: sessionId, workspaceId, status: "stopped",
    stats: JSON.stringify({ marker: statsMarker, retryAfter: "2026-06-20T00:00:00.000Z" }),
    startedAt: now,
  });

  return { projectId, issueId, workspaceId, sessionId };
}

async function getWorkspaceStatus(db: ReturnType<typeof createTestDb>["db"], workspaceId: string): Promise<string | null> {
  const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return ws?.status ?? null;
}

describe("exit-workflow: usage-limit rotation relaunch (handleUsageLimitExit)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    rotateCodexLicense.mockReset();
    rotateClaudeSubscription.mockReset();
    vi.mocked(emitButlerSystemEvent).mockClear();
  });

  it("rotates a Codex license and relaunches the builder on the fresh profile (codex provider, no claudeProfile)", async () => {
    const { projectId, issueId, workspaceId, sessionId } = await seedRateLimitedWorkspace(db, "codex-limit");
    rotateCodexLicense.mockResolvedValue({ rotated: true, fromProfile: "ki14", toProfile: "ki15", reason: "rotated to ki15" });
    const sessionManager = makeSessionManager();

    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: makeBoardEvents() as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, 1);

    expect(rotateCodexLicense).toHaveBeenCalledTimes(1);
    expect(rotateClaudeSubscription).not.toHaveBeenCalled();
    // Builder relaunched on the rotated profile, with the Codex-shaped launch options.
    expect(sessionManager.startSession).toHaveBeenCalledTimes(1);
    const opts = sessionManager.startSession.mock.calls[0][0];
    expect(opts).toMatchObject({
      workspaceId,
      provider: "codex",
      triggerType: "agent",
      profile: { provider: "codex", name: "ki15" },
    });
    expect(opts.claudeProfile).toBeUndefined();
    expect(String(opts.prompt)).toContain("ticket #700");
    // Workspace flipped back to active for the continuation.
    expect(await getWorkspaceStatus(db, workspaceId)).toBe("active");
    expect(emitButlerSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, workspaceId, text: expect.stringContaining("rotated to 'ki15'") }),
    );
  });

  it("rotates a Claude subscription and relaunches with claude-code provider + claudeProfile", async () => {
    const { workspaceId, sessionId } = await seedRateLimitedWorkspace(db, "claude-limit");
    rotateClaudeSubscription.mockResolvedValue({ rotated: true, fromProfile: "anth", toProfile: "anth2", reason: "rotated to anth2" });
    const sessionManager = makeSessionManager();

    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: makeBoardEvents() as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, 1);

    expect(rotateClaudeSubscription).toHaveBeenCalledTimes(1);
    expect(rotateCodexLicense).not.toHaveBeenCalled();
    const opts = sessionManager.startSession.mock.calls[0][0];
    expect(opts).toMatchObject({
      provider: "claude-code",
      claudeProfile: "anth2",
      profile: { provider: "claude", name: "anth2" },
    });
    expect(await getWorkspaceStatus(db, workspaceId)).toBe("active");
  });

  it("leaves the workspace blocked (no relaunch) when the ring cannot rotate", async () => {
    const { workspaceId, sessionId } = await seedRateLimitedWorkspace(db, "codex-limit");
    rotateCodexLicense.mockResolvedValue({ rotated: false, fromProfile: "ki14", reason: "all licenses cooled down" });
    const sessionManager = makeSessionManager();

    const { runWorkflowOnExit } = createWorkflowEngine({
      sessionManager: sessionManager as never,
      boardEvents: makeBoardEvents() as never,
      autoMerge: vi.fn(async () => {}),
      database: db as never,
    });

    await runWorkflowOnExit(workspaceId, sessionId, 1);

    expect(sessionManager.startSession).not.toHaveBeenCalled();
    expect(await getWorkspaceStatus(db, workspaceId)).toBe("blocked");
  });
});
