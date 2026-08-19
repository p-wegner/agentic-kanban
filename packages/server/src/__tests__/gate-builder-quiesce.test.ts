/**
 * #581 — a gate at 6 workers competing with builders manufactures assertion failures.
 *
 * Measured live: raising `verify_max_workers` 2 -> 6 (#536) cut the server suite from
 * 2380s to 1564s, and the first gate that ran at 6 workers WHILE two builders were working
 * failed three `mergeWorkspace` cases — 14943ms, 7210ms, 14106ms, all
 * `expected "vi.fn()" to be called at least once` on `removeWorktree`. The same tests at
 * the same commit: 11 passed in the branch's own worktree, 11 passed on master. Slow
 * real-git tests under load never reach cleanup, and an assertion that is really a timing
 * assertion fails while naming a real defect.
 *
 * The mechanism: while a gate holds the build-concurrency semaphore, the monitor holds new
 * builder STARTS. Nothing running is touched. These tests pin that, the opt-out, and the
 * property that makes the whole thing safe — an idle board is unaffected.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { preferences } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import {
  shouldQuiesceBuildersForGate,
  quiesceBuildersEnabled,
  quiesceBuildersDuringGatePrefKey,
} from "../services/gate-quiesce.js";
import { runUnderBuildSemaphore, buildGateBusy, buildSemaphoreActive } from "../services/jvm-build-semaphore.js";
import { buildGateTierMessage } from "../services/pre-merge-gate-tier.js";

const PROJECT_ID = "cccc1111-2222-3333-4444-555566667777";

describe("buildGateBusy (#581)", () => {
  afterEach(() => {
    expect(buildSemaphoreActive()).toBe(0); // no test may leak a held slot
  });

  it("is false on an idle board", () => {
    expect(buildGateBusy()).toBe(false);
  });

  it("is true only while a gated task is in flight", async () => {
    let observedInside = false;
    await runUnderBuildSemaphore(async () => {
      observedInside = buildGateBusy();
    });
    expect(observedInside).toBe(true);
    expect(buildGateBusy()).toBe(false);
  });

  it("releases the slot even when the gated task throws", async () => {
    await expect(runUnderBuildSemaphore(() => Promise.reject(new Error("verify blew up")))).rejects.toThrow();
    expect(buildGateBusy()).toBe(false);
  });
});

describe("builder quiescing (#581)", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
  });

  it("defaults ON — a trustworthy gate result is worth one cycle of start latency", async () => {
    await expect(quiesceBuildersEnabled(PROJECT_ID, db)).resolves.toBe(true);
  });

  it("can be turned off per project", async () => {
    await db.insert(preferences).values({ key: quiesceBuildersDuringGatePrefKey(PROJECT_ID), value: "false" });
    await expect(quiesceBuildersEnabled(PROJECT_ID, db)).resolves.toBe(false);
  });

  it("holds nothing when no gate is running — the common case costs nothing", async () => {
    await expect(shouldQuiesceBuildersForGate(PROJECT_ID, db)).resolves.toBe(false);
  });

  it("holds starts while a gate is in flight", async () => {
    let heldDuringGate: boolean | null = null;
    await runUnderBuildSemaphore(async () => {
      heldDuringGate = await shouldQuiesceBuildersForGate(PROJECT_ID, db);
    });
    expect(heldDuringGate).toBe(true);
  });

  it("respects the opt-out even during a gate", async () => {
    await db.insert(preferences).values({ key: quiesceBuildersDuringGatePrefKey(PROJECT_ID), value: "false" });
    let heldDuringGate: boolean | null = null;
    await runUnderBuildSemaphore(async () => {
      heldDuringGate = await shouldQuiesceBuildersForGate(PROJECT_ID, db);
    });
    expect(heldDuringGate).toBe(false);
  });
});

describe("the gate message says whether it ran protected (#581)", () => {
  const base = {
    strategy: "full" as const,
    packageScoped: false,
    fileScoped: false,
    changedFileCount: 3,
    guardSuiteCount: 0,
    maxWorkers: 6,
  };

  it("names the protection when builders were held", () => {
    expect(buildGateTierMessage({ ...base, buildersQuiesced: true })).toContain("builders held");
  });

  it("says so LOUDLY when they were not — that is the run whose failures are suspect", () => {
    expect(buildGateTierMessage({ ...base, buildersQuiesced: false })).toContain("builders NOT held");
  });

  it("stays silent when the state is unknown rather than claiming either", () => {
    const message = buildGateTierMessage(base);
    expect(message).not.toContain("builders");
    expect(message).toContain("workers 6");
  });
});
