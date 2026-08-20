import { describe, it, expect } from "vitest";
import {
  SESSION_TRIGGER_TRAITS,
  SESSION_TRIGGER_LITERALS,
  triggerRole,
  triggerPhase,
  triggerBadgeLabel,
  isBuilderLaunchTrigger,
  isBuilderCycleTrigger,
  humanizeSkillName,
} from "../src/lib/session-trigger.js";

/**
 * These tables are the behaviour the eight-plus scattered classifiers had before #495
 * folded them into one traits row per trigger. They are written as the ORIGINAL
 * predicates, not as reads of the table, so a change to the table has to be argued for
 * here rather than silently agreeing with itself.
 */
describe("session trigger vocabulary", () => {
  it("classifies roles the way the four identical classifyTrigger copies did", () => {
    const cases: Array<[string | null, string]> = [
      [null, "build"],
      ["agent", "build"],
      ["auto-start", "build"],
      ["plan-implement", "build"],
      ["review", "review"],
      ["skill:code-review", "review"],
      ["skill:code-review-thorough", "review"],
      ["skill:board-monitor", "noise"],
      ["skill:board-navigator", "noise"],
      ["chat", "rework"],
      ["fix-and-merge", "rework"],
      ["fix-conflicts", "rework"],
      ["plan-reject", "rework"],
      ["verify", "other"],
      ["learning", "other"],
      ["bisect", "other"],
      ["reconcile", "other"],
      ["skill:publish", "build"],
      ["something-nobody-writes", "build"],
    ];
    for (const [trigger, role] of cases) {
      expect(triggerRole(trigger), `role of ${trigger}`).toBe(role);
    }
  });

  it("keeps the launch and cycle builder predicates deliberately different", () => {
    // Launch: continues the worktree, so a rate-limit rotation relaunches it.
    for (const t of [null, "agent", "auto-start", "plan-implement", "skill:anything"]) {
      expect(isBuilderLaunchTrigger(t), `launch builder: ${t}`).toBe(true);
    }
    for (const t of ["review", "fix-and-merge", "fix-conflicts", "learning", "chat", "verify"]) {
      expect(isBuilderLaunchTrigger(t), `launch builder: ${t}`).toBe(false);
    }
    // Cycle: the ticket's implementer as the monitor counts it — auto-start and skill
    // runs are the monitor's OWN launches, and chat is a human continuing the work.
    for (const t of [null, "agent", "chat", "plan-implement"]) {
      expect(isBuilderCycleTrigger(t), `cycle builder: ${t}`).toBe(true);
    }
    for (const t of ["auto-start", "skill:anything", "review", "fix-and-merge", "learning"]) {
      expect(isBuilderCycleTrigger(t), `cycle builder: ${t}`).toBe(false);
    }
  });

  it("puts review and merge-side sessions in the landing phase", () => {
    for (const t of ["review", "merge", "fix-and-merge", "fix-conflicts"]) {
      expect(triggerPhase(t), `phase of ${t}`).toBe("landing");
    }
    for (const t of [null, "agent", "chat", "auto-start", "learning", "bisect"]) {
      expect(triggerPhase(t), `phase of ${t}`).toBe("build");
    }
  });

  it("labels skill runs from the skill name and leaves routine triggers unbadged", () => {
    expect(triggerBadgeLabel("review")).toBe("AI Review");
    expect(triggerBadgeLabel("fix-and-merge")).toBe("Fix & Merge");
    expect(triggerBadgeLabel("skill:board-monitor")).toBe("✨ Board Monitor");
    expect(triggerBadgeLabel("skill:ai-review")).toBe("✨ AI Review");
    expect(triggerBadgeLabel(null)).toBeNull();
    expect(triggerBadgeLabel("plan-implement")).toBeNull();
    expect(humanizeSkillName("code_review-api")).toBe("Code Review API");
  });

  it("every literal carries a complete traits row", () => {
    expect(SESSION_TRIGGER_LITERALS.length).toBe(Object.keys(SESSION_TRIGGER_TRAITS).length);
    for (const t of SESSION_TRIGGER_LITERALS) {
      const traits = SESSION_TRIGGER_TRAITS[t];
      expect(["review", "build", "rework", "noise", "other"]).toContain(traits.role);
      expect(["build", "landing"]).toContain(traits.phase);
      expect(typeof traits.builderLaunch).toBe("boolean");
      expect(typeof traits.builderCycle).toBe("boolean");
    }
  });
});
