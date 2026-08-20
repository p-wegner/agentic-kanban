import { describe, it, expect } from "vitest";
import { errorMessage, errorMessages, errorChain } from "../src/lib/error-message.js";

describe("errorMessage (#527)", () => {
  it("matches the idiom it replaces for the two cases the idiom handled", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(42)).toBe("42");
  });

  it("passes a plain string through unchanged", () => {
    expect(errorMessage("already a message")).toBe("already a message");
  });

  it("handles null and undefined the way String() does", () => {
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("never throws on a value String() would reject", () => {
    // A null-prototype object has no toString; `String(x)` throws on it. The inline
    // idiom would have taken the process down at the point of REPORTING an error.
    const hostile = Object.create(null) as unknown;
    expect(() => errorMessage(hostile)).not.toThrow();
    expect(errorMessage(hostile)).toBe("[unstringifiable error]");
  });

  it("subclasses of Error keep their message", () => {
    class DomainError extends Error {}
    expect(errorMessage(new DomainError("domain"))).toBe("domain");
  });
});

describe("errorMessages / errorChain", () => {
  it("walks the cause chain the inline idiom never looked at", () => {
    const root = new Error("unique constraint failed");
    const wrapped = new Error("could not save issue", { cause: root });
    expect(errorMessages(wrapped)).toEqual(["could not save issue", "unique constraint failed"]);
    expect(errorChain(wrapped)).toBe("could not save issue: unique constraint failed");
  });

  it("is cycle-safe", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a }) as Error & { cause?: unknown };
    a.cause = b;
    expect(() => errorMessages(a)).not.toThrow();
    expect(errorMessages(a).length).toBeLessThanOrEqual(8);
  });

  it("caps depth", () => {
    let err = new Error("depth-0");
    for (let i = 1; i < 20; i++) err = new Error(`depth-${i}`, { cause: err });
    expect(errorMessages(err).length).toBeLessThanOrEqual(8);
  });

  it("collapses an immediately repeated message", () => {
    const root = new Error("same");
    const wrapped = new Error("same", { cause: root });
    expect(errorMessages(wrapped)).toEqual(["same"]);
  });

  it("returns a single entry for a bare error", () => {
    expect(errorMessages(new Error("solo"))).toEqual(["solo"]);
  });
});
