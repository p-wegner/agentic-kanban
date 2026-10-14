// #1463 — the queue flush driven end to end with real git: POST /api/projects/:id/queue/flush ->
// the merge train in flush mode -> the `flush/<date>-N` tag -> the flush record -> a member comment
// -> the post-flush sweep -> a heal ticket per failure signature -> healed/merged-back.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseBranchHealth, issueComments, issues, preferences, projects, workspaces } from "@agentic-kanban/shared/schema";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { initializeProjectStatuses } from "../repositories/issue.repository.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { createProjectQueueFlushRoute } from "../routes/project-queue-flush.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";
import { createQueueFlushService } from "../services/queue-flush.service.js";
import { listOpenHealTickets } from "../services/base-health-heal-ticket.service.js";
import { readFlushState } from "../services/flush-state.js";
import { reconcileQueueFlush } from "../startup/queue-flush-sweep.js";

const git = (repoPath: string, args: string[]) => gitExecOrThrow(args, { cwd: repoPath });
const dirs: string[] = [];

async function commitOn(repoPath: string, branch: string, file: string) {
  await git(repoPath, ["checkout", "-q", branch]);
  writeFileSync(join(repoPath, file), `${file}\n`, "utf8");
  await git(repoPath, ["add", file]);
  await git(repoPath, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${file}`]);
}

async function makeRepo(): Promise<string> {
  const repoPath = mkdtempSync(join(tmpdir(), "ak-flush-e2e-"));
  dirs.push(repoPath);
  await git(repoPath, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repoPath, "base.txt"), "base\n", "utf8");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"]);
  return repoPath;
}

async function setPref(db: TestDb, key: string, value: string) {
  await db.insert(preferences).values({ key, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: preferences.key, set: { value } });
  invalidatePreferencesCache();
}

describe("queue flush, end to end (#1463)", { timeout: 120_000 }, () => {
  let db: TestDb;
  let repoPath: string;
  let stable: string;
  let projectId: string;
  let issueIds: string[];
  let app: Hono;
  const requestSweep = vi.fn(async () => ({ due: true }));
  const savedStable = process.env.KANBAN_STABLE_CHECKOUT;

  beforeEach(async () => {
    ({ db } = createTestDb());
    repoPath = await makeRepo();
    stable = mkdtempSync(join(tmpdir(), "ak-flush-stable-"));
    dirs.push(stable);
    process.env.KANBAN_STABLE_CHECKOUT = stable;
    requestSweep.mockClear();

    const now = new Date().toISOString();
    projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: "P", repoPath, repoName: "repo", defaultBranch: "main", createdAt: now, updatedAt: now });
    const statuses = await initializeProjectStatuses(projectId, now, db);
    const statusId = Object.values(statuses)[0];

    await git(repoPath, ["branch", "f1"]);
    await git(repoPath, ["branch", "f2"]);
    await commitOn(repoPath, "f1", "a.txt");
    await commitOn(repoPath, "f2", "b.txt");
    await git(repoPath, ["checkout", "-q", "main"]);

    issueIds = [];
    for (const [i, branch] of ["f1", "f2"].entries()) {
      const issueId = randomUUID();
      issueIds.push(issueId);
      await db.insert(issues).values({ id: issueId, issueNumber: i + 1, title: `Issue ${i + 1}`, priority: "medium", sortOrder: i, statusId, projectId, createdAt: now, updatedAt: now });
      await db.insert(workspaces).values({
        id: randomUUID(), issueId, branch, workingDir: join(tmpdir(), "unused-flush-wd", randomUUID()), baseBranch: "main",
        status: "idle", isDirect: false, readyForMerge: true, provider: "claude", createdAt: now, updatedAt: now,
      });
    }

    await setPref(db, `queue_flush_${projectId}`, "manual");
    await setPref(db, `risk_posture_${projectId}`, "flow");
    // The real default gate is `pnpm check:arch && pnpm typecheck` — far too heavy for a fixture repo.
    await setPref(db, `queue_flush_gate_${projectId}`, 'node -e "process.exit(0)"');

    app = new Hono();
    app.route("/api/projects", createProjectQueueFlushRoute(db as never, () => ({}) as never, { flushDeps: { requestSweep } }));
  }, 180_000);

  afterEach(() => {
    if (savedStable === undefined) delete process.env.KANBAN_STABLE_CHECKOUT;
    else process.env.KANBAN_STABLE_CHECKOUT = savedStable;
    while (dirs.length) {
      try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  const post = (body: unknown) =>
    app.request(`/api/projects/${projectId}/queue/flush`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("refuses under the default 'standard' posture, with the reason, and lands nothing", async () => {
    await setPref(db, `risk_posture_${projectId}`, "standard");
    const res = await post({});
    expect(res.status).toBe(409);
    const body = await res.json() as { refused: string };
    expect(body.refused).toMatch(/standard.*refuses a flush/);
    expect(readFlushState(stable).flushes).toHaveLength(0);
  });

  it("dry-run names the members and the heal target and changes nothing", async () => {
    const res = await post({ dryRun: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { dryRun: boolean; plan: { dryRunText: string } };
    expect(body.dryRun).toBe(true);
    expect(body.plan.dryRunText).toMatch(/would flush 2 branch\(es\).*heal target: master/);
    expect((await git(repoPath, ["tag", "--list", "flush/*"])).trim()).toBe("");
  });

  it("route -> train -> tag -> record -> member comment -> sweep -> heal ticket -> merged-back", async () => {
    const res = await post({ wait: true });
    expect(res.status).toBe(200);
    const outcome = await res.json() as { ok: boolean; merged: string[]; flush: { id: string; tag: string; state: string; landingSha: string } };
    expect(outcome.ok).toBe(true);
    expect(outcome.merged).toHaveLength(2);

    // The landing: both branches on main, tagged flush/<date>-1, at the landing sha.
    const tag = outcome.flush.tag;
    expect(tag).toMatch(/^flush\/\d{4}-\d{2}-\d{2}-1$/);
    const landingSha = (await git(repoPath, ["rev-parse", "main"])).trim();
    expect((await git(repoPath, ["rev-parse", `${tag}^{commit}`])).trim()).toBe(landingSha);
    expect(outcome.flush.landingSha).toBe(landingSha);
    const landedFiles = await git(repoPath, ["ls-tree", "-r", "--name-only", "main"]);
    expect(landedFiles).toContain("a.txt");
    expect(landedFiles).toContain("b.txt");

    // The record, already moved to `sweeping` by the first heal pass, which requested the sweep.
    const record = readFlushState(stable).flushes[0];
    expect(record).toMatchObject({ id: tag, tag, state: "sweeping", sweepTarget: "master", triggeredBy: "manual", memberIssueNumbers: expect.arrayContaining([1, 2]) });
    expect(requestSweep).toHaveBeenCalledTimes(1);

    // Every member ticket got the flush comment.
    for (const issueId of issueIds) {
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.some((c) => c.body.includes(tag) && c.body.includes("arch + typecheck"))).toBe(true);
    }

    // A red full-suite sweep at the landing sha -> one heal ticket per signature, record `healing`.
    await db.insert(baseBranchHealth).values({
      id: randomUUID(), projectId, sha: landingSha, branch: "main", outcome: "red", message: "1 failed",
      failedSuites: JSON.stringify(["packages/server/src/__tests__/x.test.ts"]), createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    const flushService = createQueueFlushService({ database: db, executeQueue: () => { throw new Error("not used"); }, requestSweep });
    await flushService.reconcileHeal(projectId);
    const healing = readFlushState(stable).flushes[0];
    expect(healing.state).toBe("healing");
    const open = await listOpenHealTickets(projectId, db);
    expect(open).toHaveLength(1);
    expect(healing.openHealTickets).toEqual([open[0].issueNumber]);

    // The next sweep is green (it closes the ticket): healed, and for master that is merged-back.
    await db.insert(baseBranchHealth).values({
      id: randomUUID(), projectId, sha: landingSha, branch: "main", outcome: "green", failedSuites: "[]", createdAt: new Date(Date.now() + 2000).toISOString(),
    });
    const { reconcileBaseHealthHealTicket } = await import("../services/base-health-heal-ticket.service.js");
    await reconcileBaseHealthHealTicket({ projectId, outcome: "green", sha: landingSha, branch: "main", repoPath }, db);
    await flushService.reconcileHeal(projectId);
    expect(readFlushState(stable).flushes[0].state).toBe("merged-back");
  });

  it("the daily cap refuses the next flush and a second POST while one runs is a refusal", async () => {
    await setPref(db, `queue_flush_daily_cap_${projectId}`, "1");
    expect((await post({ wait: true })).status).toBe(200);
    // Two more branches, ready — but the cap of 1 is spent.
    const res = await post({});
    expect(res.status).toBe(409);
    expect((await res.json() as { refused: string }).refused).toMatch(/daily flush cap/);
  });

  it("auto: the tick fires a flush when the thresholds hold, and not when mode is manual", async () => {
    const queue = createMergeQueueService({ database: db });
    const service = createQueueFlushService({ database: db, executeQueue: (ids, opts) => queue.executeQueue(ids, opts), requestSweep });
    expect((await service.evaluateAuto(projectId)).fired).toBe(false);

    await setPref(db, `queue_flush_${projectId}`, "auto");
    await setPref(db, `queue_flush_thresholds_${projectId}`, JSON.stringify({ minWaiting: 2, maxOldestAgeMinutes: 100000, arrivalsPerGateRatio: 100000 }));
    const tick = await reconcileQueueFlush({ database: db, service });
    expect(tick.fired).toEqual([projectId]);
    await vi.waitFor(() => expect(readFlushState(stable).flushes.length).toBe(1), { timeout: 60_000 });
    expect(readFlushState(stable).flushes[0].triggeredBy).toBe("auto");
    expect(readFileSync(join(stable, ".kanban", "flush-state.json"), "utf8")).toContain("flush/");
  }, 90_000);
});
