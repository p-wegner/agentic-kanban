import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { preferences } from "@agentic-kanban/shared/schema";
import type { PluginLoopGate } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { classifyUnparseableButlerReply, computeGateRecommendation, type GateNotifyArgs } from "../services/plugin-gate-butler.service.js";
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

/**
 * #355 — the typed reason must name the ACTIONABLE cause, not just "the reply wasn't JSON".
 *
 * The butler `ask` does not throw for a logged-out profile or an inaccessible model: it succeeds
 * and hands back the provider's error text as the reply body, which then fails JSON extraction. So
 * the two most common and most actionable causes — your profile is logged out, your configured
 * model is inaccessible — were indistinguishable by `reason` from a model that returned prose,
 * while the `ask-failed` reason that was declared for exactly them went unused. Both strings below
 * are verbatim from real `gate-recommendation-skipped` events on the live board.
 */
describe("classifyUnparseableButlerReply (#355)", () => {
  it("types an auth failure as auth-failed, not reply-not-json", () => {
    expect(classifyUnparseableButlerReply("Not logged in · Please run /login")).toBe("auth-failed");
    expect(classifyUnparseableButlerReply("Invalid API key provided")).toBe("auth-failed");
  });

  it("types a provider/model failure as ask-failed, not reply-not-json", () => {
    expect(classifyUnparseableButlerReply(
      "There's an issue with the selected model (Fable). It may not exist or you may not have access to it. "
      + "Run --model to pick a different model.",
    )).toBe("ask-failed");
    expect(classifyUnparseableButlerReply("You have hit your usage limit; resets at 5pm")).toBe("ask-failed");
  });

  it("reserves reply-not-json for a reply that really is the model's own prose", () => {
    expect(classifyUnparseableButlerReply(
      "I'd recommend approving this step — the PRD covers all nine sections and the checks passed.",
    )).toBe("reply-not-json");
    expect(classifyUnparseableButlerReply("")).toBe("reply-not-json");
  });
});
