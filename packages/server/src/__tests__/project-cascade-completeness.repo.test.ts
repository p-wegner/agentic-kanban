// @covers persistence-schema.cascade.delete-project [completeness-vs-unseeded-table]
//
// Why this test exists (#949, mirrors issue-cascade-completeness.repo.test.ts):
//   deleteProjectCascade used to be a second hand-maintained cascade list in
//   project.repository.ts with NO completeness gate — a new projectId-referencing
//   table added to the schema but forgotten in the walk escaped silently. The walk
//   now lives in shared/lib/cascade-delete.ts; this gate derives the project
//   deletion subtree from the Drizzle FK graph and asserts:
//     (A) the set of tables this test EXERCISES equals the schema-derived subtree —
//         adding a NEW project-referencing table turns this RED until it is seeded
//         here (and, in practice, taught to the walk);
//     (B) seeding one row in every subtree table and running deleteProjectCascade
//         removes every row referencing the project, with zero FK violations, while
//         a sibling project and global (NULL-projectId) rows stay whole;
//     (C) per-project templated preference keys (`start_mode_<id>`, …) are cleaned,
//         other keys survive;
//     (D) the cascade is ATOMIC — a failure mid-walk rolls back EVERYTHING.
//
// Scope: like the issue gate, the subtree follows only FK edges that PROPAGATE
// deletion (cascade / no-action / restrict). `preferences` has no FK — it is
// covered by the explicit test (C) instead.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { eq, like } from "drizzle-orm";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { expectedForeignKeyActions } from "@agentic-kanban/shared/lib/fk-actions";
import { applyMigrationsToClient } from "./helpers/test-db.js";
import { deleteProjectCascade } from "../repositories/project.repository.js";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/** File-backed migrated test DB (see issue-cascade-completeness for why not :memory:). */
/**
 * One directory per process, in the reaper's `ak-` namespace, holding this suite's throwaway
 * `.db` files (#840). A loose FILE is in no swept namespace whatever it is called — the fixture
 * reaper is gated on `statSync(...).isDirectory()` — so the file has to live INSIDE a swept
 * directory for anything to ever reclaim it when teardown does not run.
 */
let scratchDbDir: string | null = null;
function dbScratchDir(): string {
  if (scratchDbDir) return scratchDbDir;
  scratchDbDir = mkdtempSync(join(tmpdir(), "ak-project-cascade-completeness-"));
  return scratchDbDir;
}

function createFileTestDb(): { client: Client; db: TestDb; dispose: () => void } {
  const file = join(dbScratchDir(), `project-cascade-completeness-${randomUUID()}.db`);
  const client = createClient({ url: `file:${file}` });
  applyMigrationsToClient(client);
  client.execute("PRAGMA foreign_keys=ON");
  const db = drizzle(client, { schema });
  const dispose = (): void => {
    try {
      client.close();
    } catch {
      /* ignore */
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${file}${suffix}`, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  };
  return { client, db, dispose };
}

/**
 * Transitive DELETION subtree of `projects`, derived from the Drizzle schema FK
 * graph — same closure rule as the issue gate: a table joins if it has an FK that
 * references a table already in the subtree AND the FK's onDelete PROPAGATES
 * deletion (cascade / no-action / restrict; NOT set null / set default).
 */
function projectDeletionSubtree(): Set<string> {
  const fkByTable = expectedForeignKeyActions();
  const propagates = (action: string): boolean => action !== "set null" && action !== "set default";
  const closure = new Set<string>(["projects"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [table, specs] of fkByTable) {
      if (closure.has(table)) continue;
      if (specs.some((s) => closure.has(s.refTable) && propagates(s.onDelete))) {
        closure.add(table);
        changed = true;
      }
    }
  }
  closure.delete("projects");
  return closure;
}

/** Pre-allocated ids so seeders are independent of insertion order for references. */
interface SeedCtx {
  db: TestDb;
  projectId: string;
  statusId: string;
  issueId: string;
  workspaceId: string;
  sessionId: string;
  tagId: string;
  skillId: string;
  templateId: string;
  nodeId: string;
  driveId: string;
  scheduledRunId: string;
  milestoneId: string;
  // Sibling project that must survive the cascade untouched.
  otherProjectId: string;
  otherStatusId: string;
  otherIssueId: string;
  now: string;
}

/**
 * One seeder per subtree table, ordered so FK parents are inserted before their
 * children. The KEYS of this map are pinned to the schema-derived subtree by
 * assertion (A).
 */
const SUBTREE_SEEDERS: Record<string, (c: SeedCtx) => Promise<void>> = {
  project_statuses: async (c) => {
    await c.db.insert(schema.projectStatuses).values({
      id: c.statusId, projectId: c.projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: c.now,
    });
  },
  milestones: async (c) => {
    await c.db.insert(schema.milestones).values({
      id: c.milestoneId, projectId: c.projectId, name: "v1", createdAt: c.now,
    });
  },
  agent_skills: async (c) => {
    await c.db.insert(schema.agentSkills).values({
      id: c.skillId, name: "project-skill", description: "d", prompt: "p",
      projectId: c.projectId, createdAt: c.now, updatedAt: c.now,
    });
    // The live DB carries an FK on projects.default_skill_id (absent from the
    // Drizzle schema declaration) — point it at the doomed skill to exercise the
    // walk's defaultSkillId-nulling step.
    await c.db.update(schema.projects).set({ defaultSkillId: c.skillId }).where(eq(schema.projects.id, c.projectId));
  },
  issues: async (c) => {
    await c.db.insert(schema.issues).values({
      id: c.issueId, issueNumber: 1, title: "Issue 1", description: null,
      priority: "medium", sortOrder: 0, statusId: c.statusId, projectId: c.projectId,
      milestoneId: c.milestoneId, createdAt: c.now, updatedAt: c.now,
    });
  },
  workspaces: async (c) => {
    await c.db.insert(schema.workspaces).values({
      id: c.workspaceId, issueId: c.issueId, branch: `feature/${c.workspaceId}`,
      status: "active", skillId: c.skillId, createdAt: c.now, updatedAt: c.now,
    });
  },
  // #666 — both were absent from this map, which is exactly what the completeness
  // assertion below exists to catch: the schema declared them as deletion-subtree children
  // while nothing seeded them, so neither cascade path was ever exercised.
  workspace_issue_members: async (c) => {
    // Ticket groups (#661). Both FKs carry `onDelete: cascade`, so SQLite removes these
    // rows itself — seeding it proves the DB-level cascade actually fires, which is the
    // only thing that was untested.
    await c.db.insert(schema.workspaceIssueMembers).values({
      workspaceId: c.workspaceId, issueId: c.issueId, createdAt: c.now,
    });
  },
  workspace_provisioning: async (c) => {
    // The one that was a real bug: its FKs to issues and projects declare NO `onDelete`
    // action, so SQLite defaults to RESTRICT and the delete FAILED rather than orphaning.
    await c.db.insert(schema.workspaceProvisioning).values({
      id: randomUUID(), issueId: c.issueId, projectId: c.projectId,
      branch: "feature/provisioning", worktreePath: null, serverPid: 1234,
      phase: "worktree", startedAt: c.now,
    });
  },
  // #781: the first column family extracted out of the 88-column `workspaces` table.
  // `onDelete: cascade` on its `workspace_id` PK, so SQLite removes it with the workspace —
  // seeding it proves that cascade actually fires rather than orphaning a merge block.
  workspace_merge_backoff: async (c) => {
    await c.db.insert(schema.workspaceMergeBackoff).values({
      workspaceId: c.workspaceId, failures: 2, signature: "generic|abc123",
      error: "merge conflicts", branchSha: "head1", verifyHash: "vh1",
      nextRetryAt: c.now, since: c.now,
    });
  },
  // #798: the second column family extracted out of `workspaces`. Same shape as
  // `workspace_merge_backoff` above — `onDelete: cascade` on its `workspace_id` PK, so
  // seeding it proves the cascade fires rather than orphaning a review-preflight block.
  workspace_review_preflight: async (c) => {
    await c.db.insert(schema.workspaceReviewPreflight).values({
      workspaceId: c.workspaceId, failures: 3, error: "Rebase conflict during review preflight",
      signature: "head1..base1", blockedAt: c.now,
    });
  },
  // #798: the third column family extracted out of `workspaces` — the computed metrics
  // artifact. Same `onDelete: cascade` shape, so seeding it proves the cascade fires.
  workspace_code_metrics: async (c) => {
    await c.db.insert(schema.workspaceCodeMetrics).values({
      workspaceId: c.workspaceId, metricsJson: '{"files":3}', computedAt: c.now,
    });
  },
  // #798: the fourth column family extracted out of `workspaces` — the dependency-symlink
  // bootstrap run. Same `onDelete: cascade` shape, so seeding it proves the cascade fires.
  workspace_symlink_run: async (c) => {
    await c.db.insert(schema.workspaceSymlinkRun).values({
      workspaceId: c.workspaceId, state: "success", startedAt: c.now, endedAt: c.now,
      dirs: '["node_modules"]', linked: '["node_modules"]', skipped: "[]", failed: "[]",
      error: null,
    });
  },
  // #815: the fifth column family extracted out of `workspaces` — the pre-merge gate's
  // evidence. Same `onDelete: cascade` shape, so seeding it proves the cascade fires.
  workspace_merge_gate: async (c) => {
    await c.db.insert(schema.workspaceMergeGate).values({
      workspaceId: c.workspaceId, ranAt: c.now, stage: "verify", source: "review-exit gate",
      branchSha: "abc1234", baseSha: "def5678",
    });
  },
  // #815: the sixth column family extracted out of `workspaces` — the cached merge-tree
  // conflict probe. Same `onDelete: cascade` shape, so seeding it proves the cascade fires.
  workspace_conflict_cache: async (c) => {
    await c.db.insert(schema.workspaceConflictCache).values({
      workspaceId: c.workspaceId, checkedAt: c.now, hasConflicts: true, files: '["src/a.ts"]',
    });
  },
  // #815: the seventh column family extracted out of `workspaces` — the setup-script run.
  // Same `onDelete: cascade` shape, so seeding it proves the cascade fires.
  workspace_setup_run: async (c) => {
    await c.db.insert(schema.workspaceSetupRun).values({
      workspaceId: c.workspaceId, command: "pnpm install -r", state: "succeeded",
      startedAt: c.now, endedAt: c.now, exitCode: 0, durationMs: 1200,
      stdoutTail: "done", stderrTail: null,
    });
  },
  // #815: the eighth column family extracted out of `workspaces` — the persisted summary
  // git projection. Same `onDelete: cascade` shape, so seeding it proves the cascade fires.
  workspace_summary: async (c) => {
    await c.db.insert(schema.workspaceSummary).values({
      workspaceId: c.workspaceId, headSha: "abc1234", headMessage: "feat: seeded head",
      commitCount: 3, gitRefreshedAt: c.now, dirty: false,
    });
  },
  // #815: the ninth column family extracted out of `workspaces` — the cached
  // `git diff --shortstat` memo. Same `onDelete: cascade` shape, so seeding it proves the
  // cascade fires.
  workspace_diff_stat_cache: async (c) => {
    await c.db.insert(schema.workspaceDiffStatCache).values({
      workspaceId: c.workspaceId, checkedAt: c.now, headSha: "abc1234",
      filesChanged: 4, insertions: 120, deletions: 7,
    });
  },
  // #815: the tenth column family extracted out of `workspaces` — the computed PR-quality
  // scorecard. Same `onDelete: cascade` shape, so seeding it proves the cascade fires.
  workspace_scorecard: async (c) => {
    await c.db.insert(schema.workspaceScorecard).values({
      workspaceId: c.workspaceId, score: 88,
      json: '[{"name":"Tests","score":10,"maxScore":10,"signal":"green"}]', computedAt: c.now,
    });
  },
  sessions: async (c) => {
    await c.db.insert(schema.sessions).values({
      id: c.sessionId, workspaceId: c.workspaceId, status: "running", startedAt: c.now,
    });
  },
  session_messages: async (c) => {
    await c.db.insert(schema.sessionMessages).values({
      sessionId: c.sessionId, type: "stdout", data: "hello", createdAt: c.now,
    });
  },
  worker_events: async (c) => {
    // #774 — the per-worker timeline. It reaches this subtree only through `session_id`
    // (a cascading FK to `sessions`); there is deliberately NO `project_id` column, because
    // most of its rows — register, connect, disconnect — belong to no project, and a
    // worker's connectivity history must not be deleted by a project's lifetime.
    await c.db.insert(schema.workerEvents).values({
      id: randomUUID(), workerId: randomUUID(), type: "assigned",
      sessionId: c.sessionId, summary: "assigned to a worker", createdAt: c.now,
    });
  },
  test_runs: async (c) => {
    await c.db.insert(schema.testRuns).values({
      sessionId: c.sessionId, testName: "passes sometimes", passed: true, recordedAt: c.now,
    });
  },
  test_retry_decisions: async (c) => {
    await c.db.insert(schema.testRetryDecisions).values({
      id: randomUUID(), sessionId: c.sessionId, workspaceId: c.workspaceId,
      testName: "fails sometimes", decision: "flake", confidence: 0.9,
      createdAt: c.now, updatedAt: c.now,
    });
  },
  diff_comments: async (c) => {
    await c.db.insert(schema.diffComments).values({
      id: randomUUID(), workspaceId: c.workspaceId, filePath: "src/file.ts",
      side: "new", body: "comment", createdAt: c.now, updatedAt: c.now,
    });
  },
  repos: async (c) => {
    // Project-level repo row (no workspace) — exercises the project walk's own
    // repos delete, not just the workspace-scoped one inside the issue subtree.
    await c.db.insert(schema.repos).values({
      id: randomUUID(), projectId: c.projectId, path: `C:/tmp/${c.projectId}`, createdAt: c.now,
    });
  },
  plugin_view_processes: async (c) => {
    // #485 — entered the project deletion subtree when `project_id` gained its cascading FK
    // (migration 0120). It is an ephemeral pid/port registry of supervised plugin view
    // servers, so an orphan is a stale process record nobody will reap, not history.
    // (Its sibling `plugin_loop_events` is deliberately FK-less and so is NOT in the
    // schema-derived subtree; `deleteProjectCascade` clears it explicitly instead.)
    await c.db.insert(schema.pluginViewProcesses).values({
      id: randomUUID(), pluginRowId: randomUUID(), viewId: "dashboard",
      projectId: c.projectId, pid: 4242, port: 51234, command: "npm run serve", createdAt: c.now,
    });
  },
  workflow_transitions: async (c) => {
    await c.db.insert(schema.workflowTransitions).values({
      id: randomUUID(), workspaceId: c.workspaceId, toNodeId: "review",
      summary: "advanced", triggeredBy: "agent", createdAt: c.now,
    });
  },
  issue_artifacts: async (c) => {
    await c.db.insert(schema.issueArtifacts).values({
      id: randomUUID(), issueId: c.issueId, workspaceId: c.workspaceId,
      type: "text", content: "artifact", createdAt: c.now,
    });
  },
  issue_comments: async (c) => {
    await c.db.insert(schema.issueComments).values({
      id: randomUUID(), issueId: c.issueId, workspaceId: c.workspaceId,
      kind: "note", author: "agent", body: "comment", createdAt: c.now,
    });
  },
  issue_time_entries: async (c) => {
    await c.db.insert(schema.issueTimeEntries).values({
      id: randomUUID(), issueId: c.issueId, minutes: 15, note: null, createdAt: c.now,
    });
  },
  issue_dependencies: async (c) => {
    // Cross-project edge: dependency rows must go when EITHER endpoint dies.
    await c.db.insert(schema.issueDependencies).values({
      id: randomUUID(), issueId: c.issueId, dependsOnId: c.otherIssueId,
      type: "depends_on", createdAt: c.now,
    });
  },
  issue_tags: async (c) => {
    await c.db.insert(schema.issueTags).values({
      id: randomUUID(), issueId: c.issueId, tagId: c.tagId,
    });
  },
  showdowns: async (c) => {
    await c.db.insert(schema.showdowns).values({
      id: randomUUID(), issueId: c.issueId, status: "active", createdAt: c.now, updatedAt: c.now,
    });
  },
  drives: async (c) => {
    await c.db.insert(schema.drives).values({
      id: c.driveId, projectId: c.projectId, metaIssueId: c.issueId,
      target: "finish the epic", status: "active", startedAt: c.now,
    });
  },
  drive_obstacles: async (c) => {
    await c.db.insert(schema.driveObstacles).values({
      id: randomUUID(), projectId: c.projectId, driveId: c.driveId,
      kind: "stall", severity: "warning", summary: "stalled", detectedAt: c.now,
    });
  },
  scheduled_runs: async (c) => {
    await c.db.insert(schema.scheduledRuns).values({
      id: c.scheduledRunId, name: "nightly", projectId: c.projectId,
      skillId: c.skillId, intervalMinutes: 60, enabled: true, createdAt: c.now, updatedAt: c.now,
    });
  },
  scheduled_run_history: async (c) => {
    await c.db.insert(schema.scheduledRunHistory).values({
      id: randomUUID(), scheduledRunId: c.scheduledRunId, projectId: c.projectId,
      status: "success", triggeredBy: "cron", startedAt: c.now, createdAt: c.now,
    });
  },
  project_script_shortcuts: async (c) => {
    await c.db.insert(schema.projectScriptShortcuts).values({
      id: randomUUID(), projectId: c.projectId, name: "test", command: "pnpm test",
      cwdMode: "project", sortOrder: 0, createdAt: c.now, updatedAt: c.now,
    });
  },
  flaky_tests: async (c) => {
    await c.db.insert(schema.flakyTests).values({
      id: randomUUID(), projectId: c.projectId, testName: "flaky one", createdAt: c.now,
    });
  },
  quality_metrics: async (c) => {
    await c.db.insert(schema.qualityMetrics).values({
      id: randomUUID(), projectId: c.projectId, metricKey: "coverage.lines", value: 81.5, collectedAt: c.now,
    });
  },
  board_health_events: async (c) => {
    await c.db.insert(schema.boardHealthEvents).values({
      id: randomUUID(), projectId: c.projectId, cycleId: randomUUID(),
      eventType: "observation", summary: "all quiet", createdAt: c.now,
    });
  },
  base_branch_health: async (c) => {
    await c.db.insert(schema.baseBranchHealth).values({
      id: randomUUID(), projectId: c.projectId, sha: "deadbeef", branch: "master",
      outcome: "green", createdAt: c.now,
    });
  },
  // #906 — a persisted release train is a project-child (cascading project_id). It is
  // history, but history ABOUT one project, so it goes with the project rather than
  // outliving it as an orphan.
  merge_trains: async (c) => {
    await c.db.insert(schema.mergeTrains).values({
      id: randomUUID(), projectId: c.projectId, label: "q1", memberWorkspaceIds: "[]",
      state: "landed", startedAt: c.now,
    });
  },
  red_debt: async (c) => {
    await c.db.insert(schema.redDebt).values({
      id: randomUUID(), projectId: c.projectId, suite: "server/foo.test.ts",
      sinceCommit: "deadbeef", tag: "real", openedAt: c.now,
    });
  },
  // #775's git-token scopes. A token is a CAPABILITY, not history, so it cascades — a row
  // outliving its project would be an authorisation outliving its subject. workerId is
  // deliberately FK-less (see migration 0129), so no worker row is needed to seed one.
  worker_git_tokens: async (c) => {
    await c.db.insert(schema.workerGitTokens).values({
      tokenHash: randomUUID(), workerId: randomUUID(), projectId: c.projectId,
      incomingRef: "refs/kanban/incoming/feature/ak-1", issuedAtMs: 1, expiresAtMs: 2,
    });
  },
  workflow_templates: async (c) => {
    await c.db.insert(schema.workflowTemplates).values({
      id: c.templateId, projectId: c.projectId, name: "Custom Flow", createdAt: c.now, updatedAt: c.now,
    });
  },
  workflow_nodes: async (c) => {
    await c.db.insert(schema.workflowNodes).values({
      id: c.nodeId, templateId: c.templateId, name: "build", nodeType: "normal",
      skillId: c.skillId, createdAt: c.now,
    });
  },
  workflow_edges: async (c) => {
    await c.db.insert(schema.workflowEdges).values({
      id: randomUUID(), templateId: c.templateId, fromNodeId: c.nodeId, toNodeId: c.nodeId,
      condition: "manual", isLoop: true, createdAt: c.now,
    });
  },
};

/** Global (NULL-projectId) rows + a sibling project — all must SURVIVE the cascade. */
async function seedParentsAndSurvivors(c: SeedCtx): Promise<void> {
  await c.db.insert(schema.projects).values({
    id: c.projectId, name: "Doomed Project", repoPath: `C:/tmp/${c.projectId}`,
    repoName: "doomed", defaultBranch: "main", createdAt: c.now, updatedAt: c.now,
  });
  await c.db.insert(schema.projects).values({
    id: c.otherProjectId, name: "Survivor Project", repoPath: `C:/tmp/${c.otherProjectId}`,
    repoName: "survivor", defaultBranch: "main", createdAt: c.now, updatedAt: c.now,
  });
  await c.db.insert(schema.projectStatuses).values({
    id: c.otherStatusId, projectId: c.otherProjectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: c.now,
  });
  await c.db.insert(schema.issues).values({
    id: c.otherIssueId, issueNumber: 1, title: "Survivor issue", description: null,
    priority: "medium", sortOrder: 0, statusId: c.otherStatusId, projectId: c.otherProjectId,
    createdAt: c.now, updatedAt: c.now,
  });
  await c.db.insert(schema.tags).values({
    id: c.tagId, name: "urgent", color: null, isBuiltin: false, createdAt: c.now,
  });
  // Global template + skill (projectId NULL) — the walk must scope by projectId.
  await c.db.insert(schema.agentSkills).values({
    id: randomUUID(), name: "global-skill", description: "d", prompt: "p",
    projectId: null, isBuiltin: true, createdAt: c.now, updatedAt: c.now,
  });
  await c.db.insert(schema.workflowTemplates).values({
    id: randomUUID(), projectId: null, name: "Simple Ticket", isBuiltin: true,
    builtinKey: "simple-ticket", createdAt: c.now, updatedAt: c.now,
  });
}

function makeCtx(db: TestDb): SeedCtx {
  return {
    db,
    projectId: randomUUID(),
    statusId: randomUUID(),
    issueId: randomUUID(),
    workspaceId: randomUUID(),
    sessionId: randomUUID(),
    tagId: randomUUID(),
    skillId: randomUUID(),
    templateId: randomUUID(),
    nodeId: randomUUID(),
    driveId: randomUUID(),
    scheduledRunId: randomUUID(),
    milestoneId: randomUUID(),
    otherProjectId: randomUUID(),
    otherStatusId: randomUUID(),
    otherIssueId: randomUUID(),
    now: new Date().toISOString(),
  };
}

async function seedAll(c: SeedCtx): Promise<void> {
  await seedParentsAndSurvivors(c);
  for (const table of Object.keys(SUBTREE_SEEDERS)) {
    await SUBTREE_SEEDERS[table](c);
  }
}

async function fkViolations(client: Client): Promise<unknown[]> {
  const result = await client.execute("PRAGMA foreign_key_check");
  return result.rows;
}

describe("deleteProjectCascade — completeness vs the schema FK graph", () => {
  let db: TestDb;
  let client: Client;
  let dispose: () => void;
  beforeEach(() => {
    ({ client, db, dispose } = createFileTestDb());
  });
  afterEach(() => {
    dispose();
  });

  it("exercises every table the schema declares as a deletion-subtree child of projects", () => {
    const schemaSubtree = projectDeletionSubtree();
    const exercised = new Set(Object.keys(SUBTREE_SEEDERS));
    expect(exercised).toEqual(schemaSubtree);
  });

  it("deletes a project seeded across EVERY deletion-subtree table with no orphan or FK violation", async () => {
    const c = makeCtx(db);
    await seedAll(c);

    const fkPragma = await client.execute("PRAGMA foreign_keys");
    expect(Number(fkPragma.rows[0]?.foreign_keys ?? 0)).toBe(1);
    expect(await fkViolations(client)).toEqual([]);

    await expect(deleteProjectCascade(c.projectId, db)).resolves.toBeUndefined();

    // Strongest invariant: no row anywhere references a now-deleted parent.
    expect(await fkViolations(client)).toEqual([]);

    // Project + every projectId-scoped row are gone.
    expect(await db.select().from(schema.projects).where(eq(schema.projects.id, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.issues).where(eq(schema.issues.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.projectStatuses).where(eq(schema.projectStatuses.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.milestones).where(eq(schema.milestones.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.agentSkills).where(eq(schema.agentSkills.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.drives).where(eq(schema.drives.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.driveObstacles).where(eq(schema.driveObstacles.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.scheduledRunHistory).where(eq(schema.scheduledRunHistory.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.projectScriptShortcuts).where(eq(schema.projectScriptShortcuts.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.flakyTests).where(eq(schema.flakyTests.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.qualityMetrics).where(eq(schema.qualityMetrics.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.boardHealthEvents).where(eq(schema.boardHealthEvents.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.repos).where(eq(schema.repos.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.workflowTemplates).where(eq(schema.workflowTemplates.projectId, c.projectId))).toHaveLength(0);
    expect(await db.select().from(schema.workflowNodes).where(eq(schema.workflowNodes.templateId, c.templateId))).toHaveLength(0);
    expect(await db.select().from(schema.workflowEdges).where(eq(schema.workflowEdges.templateId, c.templateId))).toHaveLength(0);
    // Issue/workspace/session subtree fully cleared.
    expect(await db.select().from(schema.workspaces).where(eq(schema.workspaces.issueId, c.issueId))).toHaveLength(0);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.workspaceId, c.workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, c.sessionId))).toHaveLength(0);
    expect(await db.select().from(schema.testRuns).where(eq(schema.testRuns.sessionId, c.sessionId))).toHaveLength(0);
    expect(await db.select().from(schema.issueDependencies)).toHaveLength(0);

    // The sibling project and global rows are untouched.
    expect(await db.select().from(schema.projects).where(eq(schema.projects.id, c.otherProjectId))).toHaveLength(1);
    expect(await db.select().from(schema.issues).where(eq(schema.issues.id, c.otherIssueId))).toHaveLength(1);
    expect(await db.select().from(schema.projectStatuses).where(eq(schema.projectStatuses.projectId, c.otherProjectId))).toHaveLength(1);
    expect(await db.select().from(schema.tags)).toHaveLength(1);
    expect((await db.select().from(schema.agentSkills)).filter((s) => s.projectId === null)).toHaveLength(1);
    expect((await db.select().from(schema.workflowTemplates)).filter((t) => t.projectId === null)).toHaveLength(1);
  });

  it("cleans per-project templated preference keys and the activeProjectId pointer, keeping others", async () => {
    const c = makeCtx(db);
    await seedAll(c);
    const now = c.now;
    await db.insert(schema.preferences).values([
      { key: "activeProjectId", value: c.projectId, updatedAt: now },
      { key: `start_mode_${c.projectId}`, value: "monitor", updatedAt: now },
      { key: `board_strategy_${c.projectId}`, value: "{}", updatedAt: now },
      { key: `start_mode_${c.otherProjectId}`, value: "manual", updatedAt: now },
      { key: "claude_profile", value: "anth", updatedAt: now },
    ]);
    // Per-project runtime state (butler session) moved to runtime_state (#975); the
    // cascade must clean it there too.
    await db.insert(schema.runtimeState).values([
      { key: `butler_session_${c.projectId}`, value: "abc", updatedAt: now },
      { key: `butler_session_history_${c.projectId}`, value: "[]", updatedAt: now },
      { key: `butler_session_${c.otherProjectId}`, value: "keep", updatedAt: now },
    ]);

    await deleteProjectCascade(c.projectId, db);

    const remaining = (await db.select().from(schema.preferences)).map((p) => p.key).sort();
    expect(remaining).toEqual([`start_mode_${c.otherProjectId}`, "claude_profile"].sort());
    expect(await db.select().from(schema.preferences).where(like(schema.preferences.key, `%_${c.projectId}`))).toHaveLength(0);
    // The deleted project's runtime state is gone; the sibling's survives.
    const remainingState = (await db.select().from(schema.runtimeState)).map((r) => r.key).sort();
    expect(remainingState).toEqual([`butler_session_${c.otherProjectId}`]);
  });

  it("does NOT over-delete a sibling project's keys when one id is a suffix of the other (legacy numeric ids)", async () => {
    // Regression for adversarial-arch-review §3.6: the old `LIKE '%_${id}'` filter
    // treats `_` as a single-char WILDCARD, so deleting project `276` also matched
    // project `3276`'s keys (`..._3276` matches `%_276`). The live DB carries legacy
    // NUMERIC project ids (fk-violations.ts cites `project_id='3276'`), so this is a
    // real over-delete. The escaped-LIKE fix must match `_276` literally.
    const now = new Date().toISOString();
    const doomedId = "276";
    const siblingId = "3276"; // ends in the doomed id — the exact overreach case
    for (const [id, name] of [[doomedId, "Doomed"], [siblingId, "Sibling"]] as const) {
      await db.insert(schema.projects).values({
        id, name, repoPath: `C:/tmp/${id}`, repoName: name.toLowerCase(),
        defaultBranch: "main", createdAt: now, updatedAt: now,
      });
    }
    await db.insert(schema.preferences).values([
      { key: "activeProjectId", value: doomedId, updatedAt: now },
      { key: `start_mode_${doomedId}`, value: "monitor", updatedAt: now },
      { key: `board_strategy_${doomedId}`, value: "{}", updatedAt: now },
      { key: `start_mode_${siblingId}`, value: "manual", updatedAt: now },
      { key: `board_strategy_${siblingId}`, value: "{}", updatedAt: now },
    ]);
    await db.insert(schema.runtimeState).values([
      { key: `butler_session_${doomedId}`, value: "abc", updatedAt: now },
      { key: `butler_session_${siblingId}`, value: "keep", updatedAt: now },
      { key: `butler_session_history_${siblingId}`, value: "[]", updatedAt: now },
    ]);

    await deleteProjectCascade(doomedId, db);

    // Only the doomed project's keys are gone; the sibling `3276`'s SURVIVE.
    const prefs = (await db.select().from(schema.preferences)).map((p) => p.key).sort();
    expect(prefs).toEqual([`board_strategy_${siblingId}`, `start_mode_${siblingId}`].sort());
    const state = (await db.select().from(schema.runtimeState)).map((r) => r.key).sort();
    expect(state).toEqual([`butler_session_${siblingId}`, `butler_session_history_${siblingId}`].sort());
    // The sibling project row itself is untouched.
    expect(await db.select().from(schema.projects).where(eq(schema.projects.id, siblingId))).toHaveLength(1);
    expect(await db.select().from(schema.projects).where(eq(schema.projects.id, doomedId))).toHaveLength(0);
  });

  it("is ATOMIC: a failure mid-cascade rolls back the entire walk", async () => {
    const c = makeCtx(db);
    await seedAll(c);

    // An out-of-schema table with a RESTRICT-like (no action) FK to projects makes
    // the final `DELETE FROM projects` fail — the whole transaction must roll back.
    await client.execute(
      "CREATE TABLE ext_project_ref (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id))",
    );
    await client.execute({
      sql: "INSERT INTO ext_project_ref (id, project_id) VALUES (?, ?)",
      args: [randomUUID(), c.projectId],
    });

    await expect(deleteProjectCascade(c.projectId, db)).rejects.toThrow();

    // Nothing was half-gutted: project, issues, and deep subtree rows all survive.
    expect(await db.select().from(schema.projects).where(eq(schema.projects.id, c.projectId))).toHaveLength(1);
    expect(await db.select().from(schema.issues).where(eq(schema.issues.projectId, c.projectId))).toHaveLength(1);
    expect(await db.select().from(schema.workspaces).where(eq(schema.workspaces.issueId, c.issueId))).toHaveLength(1);
    expect(await db.select().from(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, c.sessionId))).toHaveLength(1);
    expect(await db.select().from(schema.drives).where(eq(schema.drives.projectId, c.projectId))).toHaveLength(1);
    expect(await db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.projectId, c.projectId))).toHaveLength(1);

    // Remove the blocker; the same cascade now succeeds cleanly.
    await client.execute("DROP TABLE ext_project_ref");
    await expect(deleteProjectCascade(c.projectId, db)).resolves.toBeUndefined();
    expect(await db.select().from(schema.projects).where(eq(schema.projects.id, c.projectId))).toHaveLength(0);
    expect(await fkViolations(client)).toEqual([]);
  });
});
