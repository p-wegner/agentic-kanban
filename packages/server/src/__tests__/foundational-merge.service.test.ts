/**
 * #797 — synchronous foundational merge. Unit tests for `isFoundationalBlocker`,
 * the detector that decides whether a just-reviewed ticket should merge SYNCHRONOUSLY
 * (because it's the scaffold/shell gating open tier-1 work) instead of waiting for the
 * 30s auto-merge-orchestrator tick.
 *
 * Acceptance (from the ticket): in a shell -> tier-1 graph the shell is recognised as
 * foundational so it lands promptly; nothing else (leaf with no dependents, ticket with
 * its own open blocker, already-done dependents) is treated as foundational.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issueDependencies, issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { isFoundationalBlocker } from "../services/foundational-merge.service.js";

type DepType = "depends_on" | "blocked_by";

describe("isFoundationalBlocker (#797)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let projectId: string;
  let backlogStatusId: string;
  let doneStatusId: string;
  const now = new Date(Date.now() - 60_000).toISOString();

  beforeEach(async () => {
    ({ db } = createTestDb());
    projectId = randomUUID();
    backlogStatusId = randomUUID();
    doneStatusId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "Test Project",
      repoPath: "/repo",
      repoName: "repo",
      defaultBranch: "master",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      { id: backlogStatusId, projectId, name: "Backlog", sortOrder: 0, isDefault: true, createdAt: now },
      { id: doneStatusId, projectId, name: "Done", sortOrder: 5, isDefault: false, createdAt: now },
    ]);
  });

  async function seedIssue(statusId: string): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      projectId,
      title: `Issue ${id.slice(0, 6)}`,
      statusId,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async function addDep(issueId: string, dependsOnId: string, type: DepType = "depends_on") {
    await db.insert(issueDependencies).values({
      id: randomUUID(),
      issueId,
      dependsOnId,
      type,
      createdAt: now,
    });
  }

  it("treats a no-dependency shell with an open tier-1 dependent as foundational", async () => {
    const shell = await seedIssue(backlogStatusId);
    const tier1 = await seedIssue(backlogStatusId);
    await addDep(tier1, shell); // tier1 depends_on shell

    expect(await isFoundationalBlocker(db, shell)).toBe(true);
  });

  it("recognises a blocked_by dependent too (not just depends_on)", async () => {
    const shell = await seedIssue(backlogStatusId);
    const tier1 = await seedIssue(backlogStatusId);
    await addDep(tier1, shell, "blocked_by");

    expect(await isFoundationalBlocker(db, shell)).toBe(true);
  });

  it("is NOT foundational when nothing depends on it (a plain leaf ticket)", async () => {
    const leaf = await seedIssue(backlogStatusId);
    expect(await isFoundationalBlocker(db, leaf)).toBe(false);
  });

  it("is NOT foundational when it has its own unresolved dependency", async () => {
    const lower = await seedIssue(backlogStatusId); // still open
    const middle = await seedIssue(backlogStatusId);
    const upper = await seedIssue(backlogStatusId);
    await addDep(middle, lower); // middle waits on lower (open) — middle is not the scaffold
    await addDep(upper, middle); // upper depends on middle

    expect(await isFoundationalBlocker(db, middle)).toBe(false);
  });

  it("IS foundational once its own dependency is already Done (no open blocker left)", async () => {
    const lower = await seedIssue(doneStatusId); // resolved
    const middle = await seedIssue(backlogStatusId);
    const upper = await seedIssue(backlogStatusId);
    await addDep(middle, lower);
    await addDep(upper, middle);

    expect(await isFoundationalBlocker(db, middle)).toBe(true);
  });

  it("is NOT foundational when the only dependent is already terminal (nothing to unblock)", async () => {
    const shell = await seedIssue(backlogStatusId);
    const doneDependent = await seedIssue(doneStatusId);
    await addDep(doneDependent, shell);

    expect(await isFoundationalBlocker(db, shell)).toBe(false);
  });

  it("ignores non-blocking relation types (related_to does not make it foundational)", async () => {
    const shell = await seedIssue(backlogStatusId);
    const other = await seedIssue(backlogStatusId);
    await db.insert(issueDependencies).values({
      id: randomUUID(),
      issueId: other,
      dependsOnId: shell,
      type: "related_to",
      createdAt: now,
    });

    expect(await isFoundationalBlocker(db, shell)).toBe(false);
  });
});
