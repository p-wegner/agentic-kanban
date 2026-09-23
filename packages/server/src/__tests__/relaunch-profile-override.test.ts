/**
 * #1047: a builder cut off by a usage limit was stranded on the account that ran out.
 *
 * The profile pinned on the workspace row wins in `applyWorkspaceAgentSelection`, no
 * endpoint re-pinned it, and the launch body carried no profile — so every relaunch went
 * back to the exhausted account and died in seconds. Measured 2026-09-05: two consecutive
 * `workspace resume` calls on #1038 both exited in ~6s on the same exhausted profile, the
 * second one AFTER the board default had been moved elsewhere and verified consistent.
 *
 * These cover the two halves of the fix: reading the override off a launch body, and
 * honoring it above the row pin WITHOUT escaping the roster that governs every other
 * selection.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { readLaunchProfileOverride, resolveRelaunchAgentSelection } from "../services/workspace-internals.js";

async function seed(
  db: ReturnType<typeof createTestDb>["db"],
  baked: { provider: string | null; claudeProfile: string | null },
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: statusId, projectId, name: "In Progress", sortOrder: 2, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 1047, title: "Test issue", priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1047-test",
    workingDir: "/repo/.worktrees/feature_ak-1047-test", baseBranch: "master",
    isDirect: false, status: "blocked",
    provider: baked.provider, claudeProfile: baked.claudeProfile,
    createdAt: now, updatedAt: now,
  });

  return { projectId, workspaceId };
}

const wsRow = async (db: ReturnType<typeof createTestDb>["db"], id: string) =>
  (await db.select().from(workspaces).where(eq(workspaces.id, id)))[0];

describe("readLaunchProfileOverride (#1047)", () => {
  it("reads the structured form and keeps its explicit provider", () => {
    expect(readLaunchProfileOverride({ profile: { provider: "codex", name: "work" } }, "claude"))
      .toEqual({ provider: "codex", name: "work" });
  });

  it("inherits the workspace provider for the legacy string form", () => {
    // A claude profile name must never be handed to a codex/copilot/pi launch.
    expect(readLaunchProfileOverride({ claudeProfile: "anth" }, "claude"))
      .toEqual({ provider: "claude", name: "anth" });
  });

  it("inherits the workspace provider when the structured form names none", () => {
    expect(readLaunchProfileOverride({ profile: { name: "anth" } }, "claude"))
      .toEqual({ provider: "claude", name: "anth" });
  });

  it("treats a blank, missing or non-string name as NO override", () => {
    // Not "no profile" — falling through to today's resolution is the point, because
    // reading a blank as an override would erase the selection entirely.
    expect(readLaunchProfileOverride({}, "claude")).toBeNull();
    expect(readLaunchProfileOverride({ claudeProfile: "   " }, "claude")).toBeNull();
    expect(readLaunchProfileOverride({ profile: { name: "" } }, "claude")).toBeNull();
    expect(readLaunchProfileOverride({ profile: null }, "claude")).toBeNull();
    expect(readLaunchProfileOverride({ profile: 42 }, "claude")).toBeNull();
  });
});

describe("resolveRelaunchAgentSelection — explicit profile override (#1047)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("outranks the profile pinned on the workspace row", async () => {
    // The #1038 shape: the row is pinned to the account that hit its usage limit.
    const { projectId, workspaceId } = await seed(db, { provider: "claude", claudeProfile: "exhausted" });

    const sel = await resolveRelaunchAgentSelection(
      db, projectId, await wsRow(db, workspaceId), undefined,
      { provider: "claude", name: "fresh" },
    );

    expect(sel.provider).toBe("claude");
    expect(sel.profile).toEqual({ provider: "claude", name: "fresh" });
  });

  it("leaves the row pin in place when no override is given", async () => {
    const { projectId, workspaceId } = await seed(db, { provider: "claude", claudeProfile: "exhausted" });

    const sel = await resolveRelaunchAgentSelection(db, projectId, await wsRow(db, workspaceId));

    expect(sel.profile).toEqual({ provider: "claude", name: "exhausted" });
  });

  it("#1226: records WHY, same as a fresh workspace launch does", async () => {
    // Observed on #1224: a resumed session's `profile_selection_reason` column stayed NULL
    // because this helper computed the resolver's reason and then dropped it before
    // returning — the caller had nowhere to read it from.
    const { projectId, workspaceId } = await seed(db, { provider: "claude", claudeProfile: "exhausted" });

    const sel = await resolveRelaunchAgentSelection(
      db, projectId, await wsRow(db, workspaceId), undefined,
      { provider: "claude", name: "fresh" },
    );

    expect(sel.profileSelectionReason).not.toBeNull();
    expect(sel.profileSelectionReason?.profile).toBe("claude:fresh");
  });

  it("is an override, not a bypass: a forbidden profile is still refused", async () => {
    // The roster remains the one enforcement seam. A `forbidden` role is refused, not
    // clamped — an override that could reach a forbidden account would make the global
    // roster liftable by anyone who can call the launch endpoint.
    const { projectId, workspaceId } = await seed(db, { provider: "claude", claudeProfile: "ok" });
    await db.insert(preferences).values({
      key: `roster_${projectId}`,
      value: JSON.stringify([
        { provider: "claude", name: "ok", role: "pool" },
        { provider: "claude", name: "banned", role: "forbidden" },
      ]),
    });

    await expect(
      resolveRelaunchAgentSelection(
        db, projectId, await wsRow(db, workspaceId), undefined,
        { provider: "claude", name: "banned" },
      ),
    ).rejects.toThrow(/roster refuses this launch/i);
  });
});
