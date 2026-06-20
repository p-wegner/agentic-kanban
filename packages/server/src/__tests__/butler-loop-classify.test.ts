import { describe, it, expect } from "vitest";
import { classifyButlerLoopError } from "../lib/butler-loop-classify.js";

const base = { aborted: false, transient: false, hasResume: false, staleResume: false, invalidThinkingSignature: false };

describe("classifyButlerLoopError", () => {
  it("abort wins over everything", () => {
    expect(classifyButlerLoopError({ ...base, aborted: true, transient: true, hasResume: true, staleResume: true })).toBe("aborted");
  });

  it("transient wins over resume-reset and fatal", () => {
    expect(classifyButlerLoopError({ ...base, transient: true, hasResume: true, staleResume: true })).toBe("transient");
  });

  it("resume-reset on stale resume id (only when resuming)", () => {
    expect(classifyButlerLoopError({ ...base, hasResume: true, staleResume: true })).toBe("resume-reset");
  });

  it("resume-reset on invalid thinking signature (only when resuming)", () => {
    expect(classifyButlerLoopError({ ...base, hasResume: true, invalidThinkingSignature: true })).toBe("resume-reset");
  });

  it("a resume error without an active resume id is fatal", () => {
    expect(classifyButlerLoopError({ ...base, hasResume: false, staleResume: true })).toBe("fatal");
    expect(classifyButlerLoopError({ ...base, hasResume: false, invalidThinkingSignature: true })).toBe("fatal");
  });

  it("an unrecognized error is fatal", () => {
    expect(classifyButlerLoopError(base)).toBe("fatal");
  });

  it("a resume in flight with no matching reason is still fatal", () => {
    expect(classifyButlerLoopError({ ...base, hasResume: true })).toBe("fatal");
  });
});
