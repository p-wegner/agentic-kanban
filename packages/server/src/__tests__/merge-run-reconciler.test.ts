// @covers workspace_merge_run [recovery]
//
// #945 — a merge job lives only in `merge-job.service.ts`'s in-memory map, so a `tsx watch`
// reload mid-gate destroyed it outright. Observed live on #919: `GET /:id/merge-status` went
// from `running` to `{"job": null}` while the workspace stayed `readyForMerge: true`,
// `status: idle`, `mergedAt: null` — no failure recorded anywhere, nothing to explain the stall
// and nothing to retry from. The workspace then sat indefinitely looking armed and healthy.
//
// The invariant these tests pin is the one the ticket names: an armed workspace is always
// either merging, or carries a RECORDED reason why it is not. So they assert on the two halves
// that make that true — the durable marker being written for a running job and cleared on every
// terminal transition, and the sweep turning a surviving marker into a timeline note rather
// than into silence.
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { issueComments, issues, projects, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { clearMergeRun, getMergeRun, setMergeRun } from "../repositories/merge-run.repository.js";
import {
  completeMergeJob,
  failMergeJob,
  getMergeJob,
  resetMergeJobs,
  runUnderMergeJob,
  setMergeRunMarkerPort,
  startMergeJob,
  MERGE_JOB_ZOMBIE_AFTER_MS,
} from "../services/merge-job.service.js";
import {
  decideMergeRunReconcileAction,
  describeInterruptedMerge,
  reconcileInterruptedMergeRuns,
} from "../startup/merge-run-reconciler.js";

type Db = ReturnType<typeof createTestDb>["db"];

const NOW_MS = Date.parse("2026-08-29T12:00:00.000Z");
/** A gate that had been running ~15 minutes when the process died — #919's own shape. */
const STARTED_ISO = new Date(NOW_MS - 15 * 60 * 1000).toISOString();

let db: Db;
let issueId: string;
let workspaceId: string;

async function seed(opts: { readyForMerge?: boolean; mergedAt?: string | null } = {}): Promise<void> {
  const projectId = randomUUID();
  const statusId = randomUUID();
  issueId = randomUUID();
  workspaceId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "C:/repos/leading" });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 1 });
  await db.insert(issues).values({ id: issueId, issueNumber: 919, title: "T", statusId, projectId });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-919",
    status: "idle",
    readyForMerge: opts.readyForMerge ?? true,
    mergedAt: opts.mergedAt ?? null,
  });
}

async function notesFor(wsId: string) {
  return db.select().from(issueComments)
    .where(and(eq(issueComments.workspaceId, wsId), eq(issueComments.kind, "merge-attempt")));
}

beforeEach(async () => {
  ({ db } = createTestDb());
  resetMergeJobs();
});

describe("the durable in-flight marker (#945)", () => {
  // The registry defaults to a NO-OP port precisely so its own unit suites never write to the
  // process-global db; these tests install the real repository against a fixture db instead,
  // which is exactly what `background-services.ts` does at startup.
  function installRealPort(): void {
    setMergeRunMarkerPort({
      set: (id, values) => setMergeRun(id, values, db),
      clear: (id) => clearMergeRun(id, db),
    });
  }

  it("writes a marker while a merge job is running", async () => {
    await seed();
    installRealPort();
    const job = startMergeJob(workspaceId, STARTED_ISO, "merge-endpoint");
    // The write is fire-and-forget, so let the microtask that performs it run.
    await new Promise((r) => setImmediate(r));

    const marker = await getMergeRun(workspaceId, db);
    expect(marker?.jobId).toBe(job.jobId);
    expect(marker?.startedAt).toBe(STARTED_ISO);
    expect(marker?.source).toBe("merge-endpoint");
  });

  it("clears the marker on success AND on failure — both terminal transitions", async () => {
    await seed();
    installRealPort();

    const ok = startMergeJob(workspaceId, STARTED_ISO);
    await new Promise((r) => setImmediate(r));
    completeMergeJob(ok.jobId, workspaceId, { merged: true });
    await new Promise((r) => setImmediate(r));
    expect(await getMergeRun(workspaceId, db)).toBeUndefined();

    const bad = startMergeJob(workspaceId, STARTED_ISO);
    await new Promise((r) => setImmediate(r));
    failMergeJob(bad.jobId, workspaceId, new Error("pre-merge gate failed"));
    await new Promise((r) => setImmediate(r));
    expect(await getMergeRun(workspaceId, db)).toBeUndefined();
  });

  it("clears the marker when a job is self-healed as a zombie", async () => {
    // The zombie heal in `getMergeJob` is a third terminal path, and it goes through the same
    // `finish()` funnel — which is the whole reason the clear lives there rather than at each
    // call site. A path that forgot to clear would write false orphans forever.
    await seed();
    installRealPort();
    const longAgo = new Date(NOW_MS - MERGE_JOB_ZOMBIE_AFTER_MS - 60_000).toISOString();
    startMergeJob(workspaceId, longAgo);
    await new Promise((r) => setImmediate(r));
    expect(await getMergeRun(workspaceId, db)).toBeDefined();

    expect(getMergeJob(workspaceId, NOW_MS)?.state).toBe("failed");
    await new Promise((r) => setImmediate(r));
    expect(await getMergeRun(workspaceId, db)).toBeUndefined();
  });

  it("a marker write failure never breaks the merge", async () => {
    await seed();
    setMergeRunMarkerPort({
      set: () => Promise.reject(new Error("db is locked")),
      clear: () => Promise.reject(new Error("db is locked")),
    });
    const job = startMergeJob(workspaceId, STARTED_ISO);
    expect(job.state).toBe("running");
    completeMergeJob(job.jobId, workspaceId, { merged: true });
    await new Promise((r) => setImmediate(r));
    // Degrades to exactly the pre-#945 behaviour rather than failing the merge.
    expect(getMergeJob(workspaceId)?.state).toBe("succeeded");
  });
});

describe("runUnderMergeJob — the join-or-own protocol (#945)", () => {
  // The monitor's auto-merge action had NO job tracking at all, so a monitor-driven merge lost
  // to a restart was as invisible as the HTTP one — and on a hands-off board it is the more
  // common case, since the monitor is what "sees the workspace as ready".
  it("owns a fresh job, completes it, and returns the result", async () => {
    const result = await runUnderMergeJob("ws-a", "monitor-auto-merge", async () => ({ merged: true }));
    expect(result).toEqual({ merged: true });
    const job = getMergeJob("ws-a");
    expect(job?.state).toBe("succeeded");
    expect(job?.result).toEqual({ merged: true });
  });

  it("fails the job it owns and rethrows the error UNCHANGED", async () => {
    // Both callers' failure handling reads this error (fix-and-merge routing, the #638
    // gate-failure exclusion), so wrapping it would break them.
    const boom = Object.assign(new Error("gate red"), { details: { mergeReason: "pre_merge_gate_failed" } });
    await expect(runUnderMergeJob("ws-b", "monitor-auto-merge", () => Promise.reject(boom))).rejects.toBe(boom);
    const job = getMergeJob("ws-b");
    expect(job?.state).toBe("failed");
    expect(job?.reason).toBe("pre_merge_gate_failed");
  });

  it("JOINS a running job instead of replacing it, and does not transition it", async () => {
    // #903 — a fresh `startMergeJob` per retry resets `startedAt`, so the zombie clock can
    // never elapse. And a joiner that completed the job would close a merge the owner is still
    // running, stamping a verdict that caller never reached.
    //
    // The owner's start time is relative to the REAL clock, not the fixed `NOW_MS` the sweep
    // tests use: `runUnderMergeJob` reads liveness through `getMergeJob`, which takes no
    // injected clock and self-heals a job silent past `MERGE_JOB_ZOMBIE_AFTER_MS`. A fixed
    // 2026-08-29 timestamp is hours stale against `Date.now()`, so the owner would be zombied
    // on read and this would test the OWN path while claiming to test the JOIN path.
    const ownerStartedAt = new Date(Date.now() - 60_000).toISOString();
    const owner = startMergeJob("ws-c", ownerStartedAt, "merge-endpoint");
    await runUnderMergeJob("ws-c", "monitor-auto-merge", async () => ({ merged: true }));
    const job = getMergeJob("ws-c");
    expect(job?.jobId).toBe(owner.jobId);
    expect(job?.state).toBe("running");
    expect(job?.startedAt).toBe(ownerStartedAt);
  });
});

describe("decideMergeRunReconcileAction (#945)", () => {
  const row = { jobId: "merge-abc-1", startedAt: STARTED_ISO };

  it("holds a marker whose job is still running in this process", () => {
    const d = decideMergeRunReconcileAction(row, true, NOW_MS);
    expect(d.action).toBe("hold");
    expect(d.reason).toContain("merge-abc-1");
  });

  it("recovers a marker with no live job, naming how long the lost run had been going", () => {
    const d = decideMergeRunReconcileAction(row, false, NOW_MS);
    expect(d.action).toBe("recover");
    expect(d.reason).toContain("15 minutes ago");
    expect(d.reason).toContain("died before the merge reached a verdict");
  });

  it("recovers rather than holding when the start time is unparseable", () => {
    // An unreadable timestamp must not become a permanent excuse not to act — the same lesson
    // `decideInstallStalenessAction` encodes for `setupEndedAt`.
    const d = decideMergeRunReconcileAction({ jobId: "j", startedAt: "not-a-date" }, false, NOW_MS);
    expect(d.action).toBe("recover");
  });
});

describe("describeInterruptedMerge (#945)", () => {
  it("says it is NOT a gate failure, and how the retry happens while armed", () => {
    const body = describeInterruptedMerge("job j died", "merge-endpoint", true);
    // The #919 confusion this exists to prevent: a stalled merge that reads as a verdict.
    expect(body).toContain("not a gate failure");
    expect(body).toContain("re-submit");
    expect(body).toContain("merge-endpoint");
  });

  it("says the opposite when the workspace is no longer armed", () => {
    const body = describeInterruptedMerge("job j died", null, false);
    expect(body).toContain("not be re-submitted automatically");
  });
});

describe("reconcileInterruptedMergeRuns (#945)", () => {
  it("records the interrupted merge and releases the marker — the #919 reproduction", async () => {
    // Exactly the observed state: armed, idle, never merged, with a merge that was in flight
    // when the process died. Before this pass, that produced nothing at all.
    await seed({ readyForMerge: true, mergedAt: null });
    await setMergeRun(workspaceId, { jobId: "merge-919-1", startedAt: STARTED_ISO, source: "merge-endpoint" }, db);

    const result = await reconcileInterruptedMergeRuns({
      database: db,
      nowMs: NOW_MS,
      log: () => {},
      hasLiveJob: () => false,
    });

    expect(result.recovered).toEqual([workspaceId]);
    const notes = await notesFor(workspaceId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("interrupted by a server restart");
    expect(notes[0]!.body).toContain("15 minutes ago");
    expect(JSON.parse(notes[0]!.payload!).mergeReason).toBe("merge_interrupted_by_restart");
    // Released, so the next sweep does not re-report the same interruption.
    expect(await getMergeRun(workspaceId, db)).toBeUndefined();
  });

  it("leaves the workspace ARMED so the ordinary auto-merge path re-submits it", async () => {
    // The merge never reached a verdict, so nothing was learned that should withdraw the
    // approval — un-arming would convert a recoverable stall into a manual one.
    await seed({ readyForMerge: true });
    await setMergeRun(workspaceId, { jobId: "j", startedAt: STARTED_ISO, source: null }, db);

    await reconcileInterruptedMergeRuns({ database: db, nowMs: NOW_MS, log: () => {}, hasLiveJob: () => false });

    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws!.readyForMerge).toBe(true);
    expect(ws!.mergedAt).toBeNull();
  });

  it("holds a marker whose job is still running — this process owns it", async () => {
    await seed();
    await setMergeRun(workspaceId, { jobId: "j", startedAt: STARTED_ISO }, db);

    const result = await reconcileInterruptedMergeRuns({
      database: db,
      nowMs: NOW_MS,
      log: () => {},
      hasLiveJob: () => true,
    });

    expect(result.acted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await notesFor(workspaceId)).toHaveLength(0);
    expect(await getMergeRun(workspaceId, db)).toBeDefined();
  });

  it("does NOT report a failure for a merge that actually LANDED before its marker was cleared", async () => {
    // The bookkeeping died, not the merge. Saying "interrupted" here would send an operator
    // looking for work that is already on the base branch.
    await seed({ readyForMerge: false, mergedAt: new Date(NOW_MS - 60_000).toISOString() });
    await setMergeRun(workspaceId, { jobId: "j", startedAt: STARTED_ISO }, db);

    const result = await reconcileInterruptedMergeRuns({
      database: db,
      nowMs: NOW_MS,
      log: () => {},
      hasLiveJob: () => false,
    });

    expect(result.recovered).toEqual([]);
    expect(await notesFor(workspaceId)).toHaveLength(0);
    expect(await getMergeRun(workspaceId, db)).toBeUndefined();
  });

  it("drops a marker whose workspace no longer exists", async () => {
    // The FK is `ON DELETE cascade`, so such a row cannot be created THROUGH the database —
    // verified: inserting one fails with SQLITE_CONSTRAINT_FOREIGNKEY. The branch guards the
    // read-then-act window instead (a workspace deleted between this pass's list and its own
    // lookup), which is why the row is handed in rather than written.
    await seed();
    const ghost = randomUUID();

    const result = await reconcileInterruptedMergeRuns({
      database: db,
      nowMs: NOW_MS,
      log: () => {},
      hasLiveJob: () => false,
      listRows: async () => [
        { workspaceId: ghost, jobId: "j", startedAt: STARTED_ISO, source: null, pid: null },
      ],
    });

    expect(result.recovered).toEqual([]);
    expect(result.acted).toBe(1);
    expect(result.reasons.map((r) => r.reason).join(" ")).toContain("dropped-orphan-marker");
    // Nothing was written about a workspace that is gone.
    expect(await notesFor(ghost)).toHaveLength(0);
  });

  it("keeps the marker when the note could not be written — never destroys the evidence twice", async () => {
    // Recording IS the deliverable. A failed note followed by a cleared marker would reproduce
    // the exact defect (#945) in a new place.
    await seed();
    await setMergeRun(workspaceId, { jobId: "j", startedAt: STARTED_ISO }, db);
    const brokenDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "insert") return () => { throw new Error("insert failed"); };
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;

    const result = await reconcileInterruptedMergeRuns({
      database: brokenDb,
      nowMs: NOW_MS,
      log: () => {},
      hasLiveJob: () => false,
    });

    expect(result.recovered).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(await getMergeRun(workspaceId, db)).toBeDefined();
  });

  it("reports an empty sweep without touching anything", async () => {
    const result = await reconcileInterruptedMergeRuns({ database: db, nowMs: NOW_MS, log: () => {} });
    expect(result.scanned).toBe(0);
    expect(result.recovered).toEqual([]);
  });
});
