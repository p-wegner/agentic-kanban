import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockProc } from "./helpers/mocks.js";
import { createSessionState } from "../services/session-manager/types.js";
import { createSessionLifecycle, type AgentService } from "../services/session-manager/session-lifecycle.js";
import type { AgentLaunchRequest } from "../services/agent-dispatch.service.js";
import type { workspaceLaunchPreflight } from "../services/preflight-check.js";

/**
 * #853 — HANDOFF.md must reach BUILDER sessions and no one else.
 *
 * The bug: the injection was gated only on `effectiveWorkingDir && !planMode &&
 * !providerSessionId`, i.e. three questions about the WORKSPACE and none about what the
 * session is FOR. A review session therefore received the implementer's own account of its
 * work (commit sha, changed files, "No critical or major issues") plus a banner telling it
 * to "avoid re-reading files you already explored" — handed to an agent whose whole job is
 * to read. 22 of 503 review sessions approved with zero tool calls.
 *
 * BOTH directions are asserted on purpose. "a review gets no handoff" alone would also pass
 * if the feature were deleted outright, so the builder case is what proves it still exists.
 * Same workspace shape, same HANDOFF.md on disk, same prompt — only `triggerType` differs.
 */

const HANDOFF_BANNER = "[SESSION HANDOFF";
const HANDOFF_BODY = "# Session Handoff\n\nLast commit abc1234. No critical or major issues.\n";

function createRecordingAgentService(): AgentService {
  return {
    launch: vi.fn((_request: AgentLaunchRequest) => createMockProc()),
    kill: vi.fn(() => true),
    closeStdin: vi.fn(() => true),
    getProcess: vi.fn(() => undefined),
    sendInput: vi.fn(() => true),
    isPidAlive: vi.fn(() => true),
  } as unknown as AgentService;
}

function okPreflight(): typeof workspaceLaunchPreflight {
  return vi.fn(async () => ({ ok: true, errors: [], staleFiles: [], refreshed: false, dirtyFiles: [] })) as unknown as typeof workspaceLaunchPreflight;
}

/** Seed a workspace whose workingDir is a REAL directory holding a HANDOFF.md. */
async function seedWorkspaceWithHandoff(db: TestDb, workingDir: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const statusId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: workingDir, repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "T", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-853", workingDir,
    baseBranch: "main", isDirect: true, status: "active", provider: "claude",
    createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

describe("#853 HANDOFF.md injection is gated on session role", () => {
  let db: TestDb;
  let workingDir: string;

  beforeEach(() => {
    ({ db } = createTestDb());
    // `ak-` prefix is mandatory in this repo — the temp-dir-namespace-guard test enforces it.
    workingDir = mkdtempSync(join(tmpdir(), "ak-handoff-853-"));
    writeFileSync(join(workingDir, "HANDOFF.md"), HANDOFF_BODY, "utf8");
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  /** Launch one session and return the prompt the agent was actually handed. */
  async function launchedPrompt(triggerType: string): Promise<string> {
    const workspaceId = await seedWorkspaceWithHandoff(db, workingDir);
    const agentService = createRecordingAgentService();
    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), {
      db, agentService, preflight: okPreflight(),
    });

    await lifecycle.startSession({ workspaceId, prompt: "review the diff", triggerType });

    expect(agentService.launch).toHaveBeenCalledOnce();
    const request = (agentService.launch as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentLaunchRequest;
    return request.prompt;
  }

  it("STILL injects the handoff for a builder session (the feature is intact)", async () => {
    const prompt = await launchedPrompt("agent");

    expect(prompt).toContain(HANDOFF_BANNER);
    expect(prompt).toContain("No critical or major issues.");
    expect(prompt).toContain("review the diff");
  });

  it("does NOT inject the handoff for a review session, with the same HANDOFF.md present", async () => {
    const prompt = await launchedPrompt("review");

    expect(prompt).not.toContain(HANDOFF_BANNER);
    expect(prompt).not.toContain("No critical or major issues.");
    // The reviewer still gets its own prompt, unmodified.
    expect(prompt).toBe("review the diff");
  });
});
