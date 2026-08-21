import { describe, it, expect } from "vitest";
import { isRunningToEndedTransition } from "./sessionTranscriptTrailing.js";

describe("isRunningToEndedTransition", () => {
  it("fires exactly on the running→ended edge", () => {
    expect(isRunningToEndedTransition(true, false)).toBe(true);
  });

  it("does not fire while still running", () => {
    expect(isRunningToEndedTransition(true, true)).toBe(false);
  });

  it("does not fire when it was never observed running", () => {
    expect(isRunningToEndedTransition(false, false)).toBe(false);
  });

  it("does not fire on an ended→running resume", () => {
    expect(isRunningToEndedTransition(false, true)).toBe(false);
  });
});
