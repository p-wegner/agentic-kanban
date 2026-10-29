// #1742 — the flush gate override is an allowlist, fails closed, and is named wherever the gate is described.
import { describe, expect, it } from "vitest";
import { DEFAULT_FLUSH_GATE_SCRIPT, resolveFlushGate } from "../services/merge-train-flush-run.js";
import { formatFlushMessage } from "../services/merge-train-flush.js";
import { formatQueueFlushDryRun } from "../services/queue-flush-trigger.service.js";
import { detectPostureOverrides } from "../services/posture-overrides.js";

describe("resolveFlushGate (#1742)", () => {
  it("unset / default / arch+typecheck resolve to the default with no override", () => {
    for (const raw of [undefined, "", "default", "arch+typecheck", DEFAULT_FLUSH_GATE_SCRIPT]) {
      expect(resolveFlushGate(raw)).toEqual({ script: DEFAULT_FLUSH_GATE_SCRIPT, override: null });
    }
  });

  it("'typecheck' is the one sanctioned weakening and is reported as an override", () => {
    expect(resolveFlushGate("typecheck")).toMatchObject({ script: "pnpm typecheck", override: "pnpm typecheck" });
  });

  it("'echo ok' and an arch-only script are refused: default script, warning", () => {
    for (const raw of ["echo ok", "pnpm check:arch"]) {
      const g = resolveFlushGate(raw);
      expect(g.script).toBe(DEFAULT_FLUSH_GATE_SCRIPT);
      expect(g.override).toBeNull();
      expect(g.warning).toContain(raw);
    }
  });
});

describe("the actual gate is named (#1742)", () => {
  it("dry-run, flush message and posture overrides carry the override", () => {
    expect(formatQueueFlushDryRun({ refusal: null, memberBranches: ["#1"], healTarget: "master", gateScript: "pnpm typecheck" })).toContain("gate = pnpm typecheck");
    expect(formatQueueFlushDryRun({ refusal: null, memberBranches: ["#1"], healTarget: "master" })).toContain("gate = arch + typecheck");
    expect(formatFlushMessage({ landedCount: 2, healTarget: "master", gateScript: "pnpm typecheck" })).toContain("gate = pnpm typecheck");
    const prefs = new Map([["queue_flush_gate_p1", "typecheck"]]);
    expect(detectPostureOverrides(prefs, "p1")).toEqual(expect.arrayContaining([expect.objectContaining({ label: "flush gate", value: "pnpm typecheck" })]));
    expect(detectPostureOverrides(new Map([["queue_flush_gate_p1", "echo ok"]]), "p1").some((o) => o.label === "flush gate")).toBe(false);
  });
});
