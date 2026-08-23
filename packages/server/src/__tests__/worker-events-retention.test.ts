/**
 * The retention answer for `worker_events` (#774), TESTED rather than promised.
 *
 * This is the part the ticket insisted on getting before the table landed: an unbounded
 * event log on a busy fleet is #738 again — 99,140 issue comments, 127 MB of a 186 MB
 * database, with a retention SERVICE already in the codebase at the time. So the bound here
 * lives on the write path, and these tests are what make "capped per worker" a fact:
 *
 *  1. Over-cap rows are actually deleted, oldest first, and the survivors are the NEWEST —
 *     a cap that dropped the recent end would be worse than none.
 *  2. The cap is per WORKER: pruning one worker never touches another's timeline.
 *  3. `deleteWorkerEvents` really empties one worker, which is the explicit deletion that
 *     makes the FK-less `worker_id` column honest rather than a shortcut.
 *  4. `recordWorkerEvent` never throws — a diagnostic must not be able to fail a
 *     registration or a revoke. Proven against a database that rejects the insert.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  WORKER_EVENT_RETENTION_LIMIT,
  countWorkerEvents,
  deleteWorkerEvents,
  insertWorkerEvent,
  listWorkerEventRows,
  pruneWorkerEvents,
} from "../repositories/worker-events.repository.js";
import { listWorkerEvents, recordWorkerEvent } from "../services/worker-events.service.js";

/** Seed n events for one worker, oldest first, one second apart so ordering is unambiguous. */
async function seedEvents(db: TestDb, workerId: string, n: number, startMs = 1_700_000_000_000) {
  for (let i = 0; i < n; i++) {
    await insertWorkerEvent(
      {
        workerId,
        type: "registered",
        summary: `event ${i}`,
        // Seeded relative to a fixed base rather than hardcoded ISO strings that age out.
        now: new Date(startMs + i * 1000).toISOString(),
      },
      db,
    );
  }
}

describe("worker_events retention", () => {
  let db: TestDb;
  let dispose: () => void;
  beforeEach(() => {
    ({ db, dispose } = createTestDb());
  });
  afterEach(() => dispose());

  it("keeps the newest rows up to the cap and deletes the rest", async () => {
    const workerId = randomUUID();
    const over = 25;
    await seedEvents(db, workerId, WORKER_EVENT_RETENTION_LIMIT + over);
    expect(await countWorkerEvents(workerId, db)).toBe(WORKER_EVENT_RETENTION_LIMIT + over);

    const deleted = await pruneWorkerEvents(workerId, WORKER_EVENT_RETENTION_LIMIT, db);

    expect(deleted).toBe(over);
    expect(await countWorkerEvents(workerId, db)).toBe(WORKER_EVENT_RETENTION_LIMIT);
    // The survivors must be the RECENT end. A cap that kept the oldest events would bound
    // the table while destroying exactly the window a fleet failure is reconstructed from.
    const rows = await listWorkerEventRows({ workerId, limit: 1 }, db);
    expect(rows[0]?.summary).toBe(`event ${WORKER_EVENT_RETENTION_LIMIT + over - 1}`);
    const remaining = await db.select().from(schema.workerEvents).where(eq(schema.workerEvents.workerId, workerId));
    expect(remaining.some((r) => r.summary === "event 0")).toBe(false);
    expect(remaining.some((r) => r.summary === `event ${over}`)).toBe(true);
  });

  it("does not prune below the cap", async () => {
    const workerId = randomUUID();
    await seedEvents(db, workerId, 10);
    expect(await pruneWorkerEvents(workerId, WORKER_EVENT_RETENTION_LIMIT, db)).toBe(0);
    expect(await countWorkerEvents(workerId, db)).toBe(10);
  });

  it("caps PER WORKER, so the table's ceiling is workers x limit", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await seedEvents(db, a, 8);
    await seedEvents(db, b, 8);

    // A cap of 5 on worker A must leave worker B's eight events untouched.
    expect(await pruneWorkerEvents(a, 5, db)).toBe(3);
    expect(await countWorkerEvents(a, db)).toBe(5);
    expect(await countWorkerEvents(b, db)).toBe(8);
  });

  it("forgets a revoked worker's whole timeline", async () => {
    const gone = randomUUID();
    const kept = randomUUID();
    await seedEvents(db, gone, 4);
    await seedEvents(db, kept, 2);

    expect(await deleteWorkerEvents(gone, db)).toBe(4);
    expect(await countWorkerEvents(gone, db)).toBe(0);
    expect(await countWorkerEvents(kept, db)).toBe(2);
    // Deleting a worker with no events is a no-op, not an error: revoke calls this
    // unconditionally.
    expect(await deleteWorkerEvents(randomUUID(), db)).toBe(0);
  });

  it("recordWorkerEvent never throws, even when the write fails", async () => {
    const workerId = randomUUID();
    // A database whose insert rejects — the shape of an FK failure or a closed connection.
    const broken = {
      insert: () => {
        throw new Error("database is locked");
      },
    } as unknown as TestDb;

    await expect(
      recordWorkerEvent({ database: broken, workerId, type: "registered", summary: "boom" }),
    ).resolves.toBeUndefined();

    // And the healthy path does persist, parsed payload included.
    await recordWorkerEvent({
      database: db,
      workerId,
      type: "protocol_mismatch",
      summary: "board 3, worker 2",
      payload: { boardProtocolVersion: 3, workerProtocolVersion: 2 },
    });
    const events = await listWorkerEvents({ database: db, workerId });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ boardProtocolVersion: 3, workerProtocolVersion: 2 });
  });

  it("filters by type and never exceeds the read cap", async () => {
    const workerId = randomUUID();
    await seedEvents(db, workerId, 3);
    await insertWorkerEvent({ workerId, type: "revoked", summary: "gone", now: new Date().toISOString() }, db);

    expect(await listWorkerEvents({ database: db, workerId, types: ["revoked"] })).toHaveLength(1);
    expect(await listWorkerEvents({ database: db, workerId, types: ["registered"] })).toHaveLength(3);
    // A caller asking for 10_000 gets the cap, not the whole table.
    expect((await listWorkerEventRows({ workerId, limit: 10_000 }, db)).length).toBeLessThanOrEqual(500);
  });
});

describe("worker_events ordering (#828)", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("orders same-millisecond events by insertion, newest first", async () => {
    const workerId = randomUUID();
    // A connect immediately followed by a close — the #699/#706 flap this timeline exists
    // to make readable. Both carry the SAME timestamp, which is what a 1ms-resolution
    // clock produces and a ~15ms Windows clock hid: with a random-UUID tiebreak the
    // panel could render the disconnect BEFORE its own connect.
    const now = new Date(1_700_000_000_000).toISOString();
    await insertWorkerEvent({ workerId, type: "connected", summary: "open", now }, db as never);
    await insertWorkerEvent({ workerId, type: "disconnected", summary: "close", now }, db as never);

    const types = (await listWorkerEvents({ workerId, database: db as never })).map((e) => e.type);
    expect(types).toEqual(["disconnected", "connected"]);
  });

  it("is stable over many same-millisecond events, not merely lucky once", async () => {
    const workerId = randomUUID();
    const now = new Date(1_700_000_000_000).toISOString();
    for (let i = 0; i < 20; i++) {
      await insertWorkerEvent({ workerId, type: "registered", summary: `e${i}`, now }, db as never);
    }
    const summaries = (await listWorkerEvents({ workerId, database: db as never })).map((e) => e.summary);
    expect(summaries).toEqual(Array.from({ length: 20 }, (_, i) => `e${19 - i}`));
  });
});
