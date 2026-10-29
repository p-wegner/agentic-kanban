// @gate:always-run when:packages/server/src/services/merge-queue-train-staging-gate.ts,packages/server/src/services/merge-queue-train.ts,packages/server/src/services/pre-merge-gate.service.ts,packages/server/src/services/risk-posture.service.ts — reads the three train-path sources off disk for the red-debt subset rule
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TRAIN_DEBT_RULE_NOTE } from "../services/merge-queue-train-staging-gate.js";
import { resolveRiskPosture } from "../services/risk-posture.service.js";

/**
 * #1746 — decision (b): the #915 red-debt subset rule is SEQUENTIAL-ONLY. The train path must
 * never mint a softened pass, so it must not reach the ledger verdict machinery. The `fast`
 * and `sprint` summaries say so instead of promising the rule unconditionally.
 */
const SERVICES = resolve(import.meta.dirname, "../services");
const TRAIN_PATH = ["merge-queue-train-staging-gate.ts", "merge-queue-train.ts", "pre-merge-gate.service.ts"];
const FORBIDDEN = /resolveRedDebtGateVerdict|redDebtGatePostureForPolicy|pass-with-debt|pass-with-new-debt/;

describe("train gate never mints a softened pass (#1746)", () => {
  it("train-path modules do not reference the red-debt verdict machinery", () => {
    for (const f of TRAIN_PATH) {
      const src = readFileSync(resolve(SERVICES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(FORBIDDEN.test(src), f).toBe(false);
    }
  });

  it("the batching posture summaries disclose that the rule is sequential-only", () => {
    for (const level of ["fast", "sprint"]) {
      const p = resolveRiskPosture(new Map([["risk_posture_p", level]]), "p");
      expect(p.summary).toMatch(/single-ticket merges only/);
    }
    expect(TRAIN_DEBT_RULE_NOTE).toMatch(/single-ticket merges only/);
  });
});
