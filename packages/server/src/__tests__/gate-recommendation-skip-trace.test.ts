import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { preferences } from "@agentic-kanban/shared/schema";
import type { PluginLoopGate } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { computeGateRecommendation, type GateNotifyArgs } from "../services/plugin-gate-butler.service.js";
import { listPluginLoopEvents } from "../repositories/plugin-loop-events.repository.js";

/**
 * A gate that gets no butler pre-read must say WHY in its own timeline.
 *
 * Before this, every bail-out in `computeGateRecommendation` returned silently and at most
 * warned to a stdout nobody captures. A live project reached two gates and produced zero
 * recommendations, and the absence of any trace made a disabled pref, a cold butler and a
 * malformed model reply indistinguishable — so the #317 reordering fix could not even be
 * evaluated, since "no event" looked the same before and after it.
 */
const GATE: PluginLoopGate = {
  id: "step-2:v1",
  question: "Approve step 2/9 — Product Requirements Document (v1)?",
  artifacts: ["docs/pm-pipeline/steps/step-2/prd.md"],
  actions: [
    { id: "approve", label: "Approve" },
    { id: "revise", label: "Needs revision", input: "text" },
  ],
};

function gateArgs(projectId: string): GateNotifyArgs {
  return {
    projectId,
    pluginRowId: randomUUID(),
    pluginSlug: "pm-pipeline",
    pluginName: "PM Pipeline",
    loopName: "pipeline",
    loopLabel: "PM pipeline (step 1 to 9)",
    gate: GATE,
    checks: null,
    note: null,
    repoPath: "C:/tmp/does-not-matter",
    boardUrl: "http://localhost:3001",
  };
}

describe("computeGateRecommendation — skip trace", () => {
  it("records WHY when the recommendation feature is switched off", async () => {
    const { db } = createTestDb();
    const projectId = randomUUID();
    await db.insert(preferences).values([
      { key: "butler_gate_recommendation", value: "false", updatedAt: new Date().toISOString() },
    ]);

    await computeGateRecommendation(gateArgs(projectId), db as unknown as Database);

    const events = await listPluginLoopEvents(
      { pluginSlug: "pm-pipeline", loopName: "pipeline", projectId },
      100,
      db as unknown as Database,
    );
    const skips = events.filter((e) => e.type === "gate-recommendation-skipped");
    expect(skips).toHaveLength(1);
    expect(JSON.parse(skips[0].payloadJson ?? "{}")).toMatchObject({
      gateId: "step-2:v1",
      reason: "disabled",
    });
    // And it must NOT have invented a recommendation.
    expect(events.some((e) => e.type === "gate-recommendation")).toBe(false);
  });

  it("records WHY when no butler can be warmed for the project", async () => {
    const { db } = createTestDb();
    // No project row is seeded, so `ensureWarmButler` cannot resolve one and bails — the
    // same shape as the live failure, where the project never had a warm butler.
    const projectId = randomUUID();

    await computeGateRecommendation(gateArgs(projectId), db as unknown as Database);

    const events = await listPluginLoopEvents(
      { pluginSlug: "pm-pipeline", loopName: "pipeline", projectId },
      100,
      db as unknown as Database,
    );
    const skips = events.filter((e) => e.type === "gate-recommendation-skipped");
    expect(skips).toHaveLength(1);
    expect(JSON.parse(skips[0].payloadJson ?? "{}")).toMatchObject({
      gateId: "step-2:v1",
      reason: "no-warm-butler",
    });
  });
});
