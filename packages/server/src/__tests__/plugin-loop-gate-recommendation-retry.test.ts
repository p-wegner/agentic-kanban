/**
 * #367 — the retry must actually FIRE from the advance path, not merely be decidable.
 *
 * `gate-recommendation-retry.test.ts` covers the POLICY (the pure decision + the timeline read).
 * That is not enough to close #367: the original defect was not a wrong decision, it was that
 * `computeGateRecommendation` had exactly ONE call site — inside
 * `if (plan.gate && plan.gate.id !== priorGate?.id)` — so nothing ever asked the question a second
 * time. A policy module that no advance consults would reproduce the bug with tests green.
 *
 * So these tests drive the real `advanceLoop` twice over the SAME still-open gate, with the butler
 * module faked, and assert on how many times the board asked:
 *   1. first attempt failed (no `gate-recommendation` event) → the next advance asks AGAIN;
 *   2. a recommendation already on record → the next advance does NOT ask (no wasted butler call);
 *   3. once the retry succeeds the recommendation is persisted and the chip is no longer null.
 *
 * MEASURED provenance of the bug: linklocker sat on gate `step-2:v1` for 23 hours with
 * `gateRecommendation: null` across 350 further advances; approving it produced a populated chip
 * for the next gate immediately, so the path was healthy and the null was frozen state.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { pluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { seedProject } from "./helpers/workflow-test-helpers.js";
import { getPluginService } from "../services/plugin.service.js";
import { insertPluginLoopEvent } from "../repositories/plugin-loop-events.repository.js";
import { resetGateRecommendationAttempts } from "../services/gate-recommendation-retry.js";
import type { Database } from "../db/index.js";
import type { CreateIssueInput, CreateIssueResult } from "../services/issue.service.js";

const GATE_ID = "step-2:v1";

/**
 * The fake butler. Hoisted because `vi.mock` is, and shared state is how "did the board ask
 * again?" becomes observable — the real call is `void import(...)`, fire-and-forget, so there is
 * no return value to assert on.
 */
const butler = vi.hoisted(() => ({
  calls: [] as string[],
  /** "fail" = the transient failure this ticket is about ("Not logged in", model error, quota). */
  mode: "fail" as "fail" | "succeed",
}));

vi.mock("../services/plugin-gate-butler.service.js", () => ({
  /**
   * Faithful in the one respect that matters: on success the REAL function's observable effect is
   * a `gate-recommendation` timeline event written through the `database` it is handed, which is
   * both what the chip reads and what suppresses further retries.
   */
  computeGateRecommendation: async (
    args: { projectId: string; pluginSlug: string; loopName: string; gate: { id: string } },
    database: Database,
  ) => {
    butler.calls.push(args.gate.id);
    if (butler.mode === "fail") throw new Error("Not logged in · Please run /login");
    await insertPluginLoopEvent(
      { pluginSlug: args.pluginSlug, loopName: args.loopName, projectId: args.projectId },
      "gate-recommendation",
      { gateId: args.gate.id, actionId: "approve", reason: "artifacts look complete" },
      database,
    );
  },
  notifyButlerOfGate: async () => {},
}));

const tempDirs: string[] = [];

function makeGatePluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-loop-gate-retry-plugin-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify({
    id: "gate-plugin",
    name: "Gate Plugin",
    skills: [{ dir: "skills/analysis" }],
    loops: [{ name: "sweep", skill: "analysis", plan: { command: "node plan.mjs" } }],
  }, null, 2));
  const skillDir = join(dir, "skills", "analysis");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# analysis");
  // "Blocked on a human, not done" — units: [], converged: false, plus a stable gate id. Every
  // advance reports the SAME gate, which is precisely the state linklocker was frozen in.
  writeFileSync(join(dir, "plan.mjs"), `console.log(JSON.stringify(${JSON.stringify({
    units: [],
    converged: false,
    note: "awaiting approval",
    gate: {
      id: GATE_ID,
      question: "Approve step 2?",
      actions: [{ id: "approve", label: "Approve" }, { id: "revise", label: "Needs revision", input: "text" }],
      resolve: { command: "node resolve.mjs" },
    },
  })}));\n`);
  return dir;
}

async function setupGatedLoop(db: TestDb) {
  const { projectId } = await seedProject(db, "Gate Project");
  const createIssue = async (input: CreateIssueInput): Promise<CreateIssueResult> => {
    void input;
    throw new Error("this planner never plans units — it is parked on a gate");
  };
  const service = getPluginService(db as unknown as Database, { createIssue });
  const plugin = await service.installPlugin({ source: makeGatePluginDir() });
  await db.insert(schema.preferences).values({
    key: pluginEnabledPreferenceKey("gate-plugin", projectId),
    value: "true",
    updatedAt: new Date().toISOString(),
  });
  return { projectId, plugin, service };
}

/** The attempt is fire-and-forget; give its promise chain (incl. the in-flight release) a turn. */
const settle = () => new Promise((r) => setTimeout(r, 30));

/**
 * Age every event of this loop, so the retry's backoff (shortest delay: 5 minutes) cannot be the
 * reason a later advance does or does not ask. Without this the second advance would always be
 * inside the backoff window and BOTH the positive and the negative case would "pass".
 */
async function ageLoopEvents(db: TestDb, projectId: string, hours: number) {
  await db
    .update(schema.pluginLoopEvents)
    .set({ createdAt: new Date(Date.now() - hours * 60 * 60_000).toISOString() })
    .where(and(
      eq(schema.pluginLoopEvents.projectId, projectId),
      eq(schema.pluginLoopEvents.pluginSlug, "gate-plugin"),
    ));
}

function recommendationEvents(db: TestDb, projectId: string) {
  return db
    .select()
    .from(schema.pluginLoopEvents)
    .where(and(
      eq(schema.pluginLoopEvents.projectId, projectId),
      eq(schema.pluginLoopEvents.type, "gate-recommendation"),
    ));
}

describe("#367 the advance path retries a failed gate recommendation", () => {
  beforeEach(() => {
    butler.calls.length = 0;
    butler.mode = "fail";
    resetGateRecommendationAttempts();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — best-effort */
      }
    }
  });

  it("asks again on a later advance when the first attempt failed and left no recommendation", async () => {
    const { db } = createTestDb();
    const { projectId, plugin, service } = await setupGatedLoop(db);

    // Advance 1: the gate id transition — the ONE attempt the original code allowed.
    await service.advanceLoop(plugin.id, "sweep", projectId);
    await settle();
    expect(butler.calls).toEqual([GATE_ID]);
    // It failed, so the gate has no chip. This is the frozen state, 350 advances deep.
    expect(await recommendationEvents(db, projectId)).toHaveLength(0);

    await ageLoopEvents(db, projectId, 1);

    // Advance 2: SAME gate, still open. Pre-#367 this branch did nothing at all.
    await service.advanceLoop(plugin.id, "sweep", projectId);
    await settle();
    expect(butler.calls).toEqual([GATE_ID, GATE_ID]);
  });

  it("persists the recommendation once the retry succeeds, so the chip is no longer null", async () => {
    const { db } = createTestDb();
    const { projectId, plugin, service } = await setupGatedLoop(db);

    await service.advanceLoop(plugin.id, "sweep", projectId);
    await settle();
    expect(await recommendationEvents(db, projectId)).toHaveLength(0);
    const beforeRetry = await service.listLoops(plugin.id, projectId);
    expect(beforeRetry[0]).toMatchObject({ gate: { id: GATE_ID }, gateRecommendation: null });

    await ageLoopEvents(db, projectId, 1);
    butler.mode = "succeed"; // the transient failure cleared, as they do

    await service.advanceLoop(plugin.id, "sweep", projectId);
    await settle();

    expect(await recommendationEvents(db, projectId)).toHaveLength(1);
    const afterRetry = await service.listLoops(plugin.id, projectId);
    expect(afterRetry[0]).toMatchObject({
      gate: { id: GATE_ID },
      gateRecommendation: { actionId: "approve", reason: "artifacts look complete" },
    });
  });

  it("does NOT ask again when a recommendation for that gate already exists (negative control)", async () => {
    const { db } = createTestDb();
    butler.mode = "succeed";
    const { projectId, plugin, service } = await setupGatedLoop(db);

    await service.advanceLoop(plugin.id, "sweep", projectId);
    await settle();
    expect(butler.calls).toEqual([GATE_ID]);
    expect(await recommendationEvents(db, projectId)).toHaveLength(1);

    // Aged past every backoff window, so "already recommended" is the only thing that can hold
    // the retry off — a second ask here would be a wasted LLM call on every monitor cycle.
    await ageLoopEvents(db, projectId, 24);
    await service.advanceLoop(plugin.id, "sweep", projectId);
    await settle();
    await service.advanceLoop(plugin.id, "sweep", projectId);
    await settle();

    expect(butler.calls).toEqual([GATE_ID]);
    expect(await recommendationEvents(db, projectId)).toHaveLength(1);
  });
});
