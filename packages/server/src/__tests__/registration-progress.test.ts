// @covers projects.registration.progress [observability, boundary]
//
// #388 — registering a project showed a 30-40s spinner with nothing to read: the user could not
// tell cloning from stack detection from hook scaffolding from a hang. On this machine, where a
// zero-work `git --version` has measured 68ms to 51.8s (#368), "is it working or wedged?" is not
// an idle question.
//
// NO timing target is asserted anywhere here, per the reporting rule the ticket carries: timing on
// that box is unusable and any before/after duration comparison would be noise. What is asserted
// is that the PHASES are legible — including the ones that are skipped or fail.
import { afterEach, describe, expect, it } from "vitest";
import {
  beginRegistrationPhase,
  clearRegistrationProgress,
  endRegistrationPhase,
  finishRegistrationProgress,
  getRegistrationProgress,
  startRegistrationProgress,
  REGISTRATION_PHASE_LABELS,
} from "../services/registration-progress.service.js";

afterEach(() => clearRegistrationProgress());

describe("registration progress (#388)", () => {
  it("records phases in order, closing the previous one as it goes", () => {
    const id = startRegistrationProgress("reg-1")!;
    beginRegistrationPhase(id, "inspect-repo");
    beginRegistrationPhase(id, "scaffold");
    const progress = getRegistrationProgress(id)!;
    expect(progress.phases.map((p) => [p.phase, p.status])).toEqual([
      ["inspect-repo", "done"],
      ["scaffold", "running"],
    ]);
  });

  it("carries a human label the client cannot drift from", () => {
    // The server owns the wording because it owns what actually runs.
    const id = startRegistrationProgress("reg-2")!;
    beginRegistrationPhase(id, "clone");
    expect(getRegistrationProgress(id)!.phases[0].label).toBe(REGISTRATION_PHASE_LABELS.clone);
  });

  it("reports a SKIPPED phase with its reason — the part a spinner could never show", () => {
    const id = startRegistrationProgress("reg-3")!;
    beginRegistrationPhase(id, "seed-skills");
    endRegistrationPhase(id, "skipped", "skill export is off for this board");
    const phase = getRegistrationProgress(id)!.phases[0];
    expect(phase.status).toBe("skipped");
    expect(phase.note).toContain("off for this board");
  });

  it("never leaves a phase reading 'running' after a failure", () => {
    // That would be the very hang this ticket is about, one level down.
    const id = startRegistrationProgress("reg-4")!;
    beginRegistrationPhase(id, "clone");
    finishRegistrationProgress(id, "Clone failed: repository not found");
    const progress = getRegistrationProgress(id)!;
    expect(progress.phases[0].status).toBe("failed");
    expect(progress.done).toBe(true);
    expect(progress.error).toContain("Clone failed");
  });

  it("marks a clean finish done without inventing a failure", () => {
    const id = startRegistrationProgress("reg-5")!;
    beginRegistrationPhase(id, "finalize");
    finishRegistrationProgress(id);
    const progress = getRegistrationProgress(id)!;
    expect(progress.phases[0].status).toBe("done");
    expect(progress.error).toBeUndefined();
  });

  it("is inert for a caller that passes no id", () => {
    // Progress is opt-in; a CLI/MCP registration must not pay for a UI affordance.
    expect(startRegistrationProgress(undefined)).toBeNull();
    expect(() => beginRegistrationPhase(null, "scaffold")).not.toThrow();
    expect(() => endRegistrationPhase(null, "done")).not.toThrow();
    expect(() => finishRegistrationProgress(null)).not.toThrow();
  });

  it("returns null for an unknown id rather than an empty shell", () => {
    // "Never heard of it" and "not yet at its first phase" are different answers, and a spinner
    // that cannot tell them apart is what this fixes.
    expect(getRegistrationProgress("no-such-registration")).toBeNull();
  });

  it("keeps a finished entry readable for a slightly-late poll", () => {
    const id = startRegistrationProgress("reg-6")!;
    beginRegistrationPhase(id, "finalize");
    finishRegistrationProgress(id);
    expect(getRegistrationProgress(id)?.done).toBe(true);
  });
});
