import { describe, it, expect, afterEach } from "vitest";
import {
  checkWorkspaceTransition,
  checkIssueStatusTransition,
  WORKSPACE_STATUS_TRANSITIONS,
  ISSUE_STATUS_TRANSITIONS,
  getTransitionStrictness,
  setTransitionStrictness,
  IllegalStatusTransitionError,
} from "../src/lib/status-transitions.js";

/**
 * Pure-classifier tests for the legal-transition tables (arch-review §1.1).
 * The DB-coupled enforcement in the two setters is covered by the server-side
 * status-transition-authority.test.ts; here we exercise the pure policy.
 */

describe("status-transitions — legal-transition tables (arch-review §1.1)", () => {
  const original = getTransitionStrictness();
  afterEach(() => setTransitionStrictness(original));

  describe("checkWorkspaceTransition", () => {
    it("classifies a legal transition as ok (silent)", () => {
      const check = checkWorkspaceTransition("active", "idle");
      expect(check.legal).toBe(true);
      expect(check.severity).toBe("ok");
      expect(check.message).toBeUndefined();
    });

    it("treats a self-transition as legal", () => {
      expect(checkWorkspaceTransition("reviewing", "reviewing").severity).toBe("ok");
    });

    it("classifies an unexpected transition as a warn-severity illegal transition", () => {
      // "error" may only go to active/idle/blocked/closed — never straight to "reviewing".
      const check = checkWorkspaceTransition("error", "reviewing");
      expect(check.legal).toBe(false);
      expect(check.severity).toBe("warn");
      expect(check.message?.toLowerCase()).toContain("error");
      expect(check.message).toContain("reviewing");
    });

    it("classifies reviving a terminal closed+merged workspace as forbidden", () => {
      const check = checkWorkspaceTransition("closed", "idle", { mergedAt: new Date().toISOString() });
      expect(check.legal).toBe(false);
      expect(check.severity).toBe("forbidden");
      expect(check.message?.toLowerCase()).toContain("terminal");
    });

    it("allows reviving a closed workspace WITHOUT mergedAt (abandoned close)", () => {
      expect(checkWorkspaceTransition("closed", "idle", { mergedAt: null }).legal).toBe(true);
    });

    it("allows a forced revive of a terminal workspace", () => {
      const check = checkWorkspaceTransition("closed", "idle", {
        mergedAt: new Date().toISOString(),
        force: true,
      });
      expect(check.severity).toBe("ok");
    });

    it("every table target is itself a known workspace status key", () => {
      const keys = new Set(Object.keys(WORKSPACE_STATUS_TRANSITIONS));
      for (const [, targets] of Object.entries(WORKSPACE_STATUS_TRANSITIONS)) {
        for (const t of targets) expect(keys.has(t)).toBe(true);
      }
    });
  });

  describe("checkIssueStatusTransition (by canonical status name)", () => {
    it("classifies a legal canonical transition as ok", () => {
      expect(checkIssueStatusTransition("Todo", "In Progress").severity).toBe("ok");
    });

    it("allows reopening a Done issue (legal back-edge)", () => {
      expect(checkIssueStatusTransition("Done", "In Progress").legal).toBe(true);
    });

    it("flags an unexpected canonical transition as warn-severity", () => {
      // Backlog may not jump straight to AI Reviewed.
      const check = checkIssueStatusTransition("Backlog", "AI Reviewed");
      expect(check.legal).toBe(false);
      expect(check.severity).toBe("warn");
    });

    it("treats any non-canonical (custom) status name as ok — custom lanes never warn", () => {
      expect(checkIssueStatusTransition("Custom Stage", "In Progress").severity).toBe("ok");
      expect(checkIssueStatusTransition("Todo", "Bespoke QA").severity).toBe("ok");
    });

    it("every issue-table target is a canonical status name", () => {
      const canonical = new Set(Object.keys(ISSUE_STATUS_TRANSITIONS));
      for (const [, targets] of Object.entries(ISSUE_STATUS_TRANSITIONS)) {
        for (const t of targets) expect(canonical.has(t)).toBe(true);
      }
    });
  });

  describe("strictness policy", () => {
    it("defaults to warn and is settable", () => {
      setTransitionStrictness("strict");
      expect(getTransitionStrictness()).toBe("strict");
      setTransitionStrictness("warn");
      expect(getTransitionStrictness()).toBe("warn");
    });

    it("IllegalStatusTransitionError carries its name", () => {
      const err = new IllegalStatusTransitionError("boom");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("IllegalStatusTransitionError");
    });
  });
});
