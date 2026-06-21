import { describe, it, expect } from "vitest";
import {
  classifySessionExit,
  type SessionExitInputs,
  type SessionExitAction,
} from "../startup/session-exit-classification.js";

/** All-false / clean-exit baseline; override only the fields a case cares about. */
function inputs(over: Partial<SessionExitInputs> = {}): SessionExitInputs {
  return {
    wasPlanMode: false,
    isFixAndMerge: false,
    isLearning: false,
    isReview: false,
    exitCode: 0,
    ...over,
  };
}

describe("classifySessionExit", () => {
  describe("the two terminal routes for a clean (exit 0) non-special session", () => {
    it("routes a plain builder session to 'builder'", () => {
      expect(classifySessionExit(inputs()).action).toBe("builder");
    });

    it("routes a clean-exit review session to 'review'", () => {
      expect(classifySessionExit(inputs({ isReview: true })).action).toBe("review");
    });
  });

  describe("non-zero / unknown exit code", () => {
    it("routes a plain (non-special) non-zero exit to 'failed'", () => {
      expect(classifySessionExit(inputs({ exitCode: 1 })).action).toBe("failed");
    });

    it("treats a null exit code (could not be determined) as 'failed'", () => {
      expect(classifySessionExit(inputs({ exitCode: null })).action).toBe("failed");
    });

    // The crux of several exit-path outages: a CRASHED review session must NOT have
    // its reviewer "verdict" applied — it is a failed session, not a review.
    it("routes a review session that exits non-zero to 'failed', NOT 'review'", () => {
      const c = classifySessionExit(inputs({ isReview: true, exitCode: 1 }));
      expect(c.action).toBe("failed");
      expect(c.action).not.toBe("review");
    });

    it("routes a builder session that exits non-zero to 'failed', NOT 'builder'", () => {
      const c = classifySessionExit(inputs({ exitCode: 137 }));
      expect(c.action).toBe("failed");
    });
  });

  describe("fix-and-merge and learning win over the exit code", () => {
    // A fix-and-merge resolver owns its own exit-code handling (retry on 0, surface
    // on non-zero) — it must reach that handler on BOTH exit codes, never "failed".
    it("routes a fix-and-merge session to 'fix-and-merge' on a clean exit", () => {
      expect(classifySessionExit(inputs({ isFixAndMerge: true })).action).toBe("fix-and-merge");
    });

    it("routes a fix-and-merge session to 'fix-and-merge' even on a non-zero exit", () => {
      const c = classifySessionExit(inputs({ isFixAndMerge: true, exitCode: 1 }));
      expect(c.action).toBe("fix-and-merge");
      expect(c.action).not.toBe("failed");
    });

    // A learning step has no follow-on workflow — it is cleaned up on either exit
    // code and must never be reported as a generic failed session.
    it("routes a learning session to 'learning-cleanup' on a clean exit", () => {
      expect(classifySessionExit(inputs({ isLearning: true })).action).toBe("learning-cleanup");
    });

    it("routes a learning session to 'learning-cleanup' even on a non-zero exit", () => {
      const c = classifySessionExit(inputs({ isLearning: true, exitCode: 1 }));
      expect(c.action).toBe("learning-cleanup");
      expect(c.action).not.toBe("failed");
    });

    it("prefers fix-and-merge over learning when (defensively) both flags are set", () => {
      expect(
        classifySessionExit(inputs({ isFixAndMerge: true, isLearning: true })).action,
      ).toBe("fix-and-merge");
    });
  });

  describe("plan-mode skip has the highest priority", () => {
    it("routes a plan-mode session to 'plan-mode-skip' on a clean exit", () => {
      expect(classifySessionExit(inputs({ wasPlanMode: true })).action).toBe("plan-mode-skip");
    });

    it.each<[string, Partial<SessionExitInputs>]>([
      ["a fix-and-merge session", { isFixAndMerge: true }],
      ["a learning session", { isLearning: true }],
      ["a review session", { isReview: true }],
      ["a non-zero exit", { exitCode: 1 }],
      ["every role flag + a non-zero exit", { isFixAndMerge: true, isLearning: true, isReview: true, exitCode: 1 }],
    ])("plan-mode beats %s", (_label, over) => {
      expect(classifySessionExit(inputs({ wasPlanMode: true, ...over })).action).toBe("plan-mode-skip");
    });
  });

  // Full priority ladder, expressed as the exact sequence the original control flow
  // checked: wasPlanMode → isFixAndMerge → isLearning → exitCode!==0 → isReview → builder.
  describe("full priority ladder", () => {
    it.each<[SessionExitAction, SessionExitInputs]>([
      ["plan-mode-skip", inputs({ wasPlanMode: true, isFixAndMerge: true, isLearning: true, isReview: true, exitCode: 1 })],
      ["fix-and-merge", inputs({ isFixAndMerge: true, isLearning: true, isReview: true, exitCode: 1 })],
      ["learning-cleanup", inputs({ isLearning: true, isReview: true, exitCode: 1 })],
      ["failed", inputs({ isReview: true, exitCode: 1 })],
      ["review", inputs({ isReview: true, exitCode: 0 })],
      ["builder", inputs({ exitCode: 0 })],
    ])("resolves to %s for the highest matching rung", (expected, given) => {
      expect(classifySessionExit(given).action).toBe(expected);
    });
  });
});
