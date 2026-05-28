import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isTransientNetworkError } from "../startup/transient-errors.js";

describe("isTransientNetworkError", () => {
  it("classifies ECONNRESET as transient", () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("classifies ECONNREFUSED as transient", () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("classifies EPIPE as transient", () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("does not classify TypeError as transient", () => {
    expect(isTransientNetworkError(new TypeError("bad thing"))).toBe(false);
  });

  it("does not classify EADDRINUSE as transient (must stay fatal)", () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it("classifies based on message when code is missing", () => {
    expect(isTransientNetworkError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("handles null/undefined safely", () => {
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });
});

/**
 * Simulate the butler-sdk runLoop's failure mode: the Anthropic HTTPS socket gets
 * killed mid-stream and the async iterator throws ECONNRESET. The surrounding
 * service must NOT propagate it — it should log a warning and clean up.
 */
describe("butler-sdk runLoop swallows ECONNRESET from the SDK iterator", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /**
   * Mirror the runLoop's try/catch shape. If this throws, the real runLoop would
   * propagate to uncaughtException — exactly the dev-server crash we're fixing.
   */
  async function runLoopShape(iter: AsyncIterable<unknown>): Promise<{ caughtTransient: boolean; reThrew: boolean }> {
    let caughtTransient = false;
    let reThrew = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _msg of iter) {
        // drain
      }
    } catch (err) {
      if (isTransientNetworkError(err)) {
        caughtTransient = true;
        console.warn(`[butler-sdk] transient network error (ignored): ${(err as Error).message}`);
      } else {
        reThrew = true;
        throw err;
      }
    }
    return { caughtTransient, reThrew };
  }

  it("swallows ECONNRESET from the SDK async iterator", async () => {
    const iter: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
        };
      },
    };
    const result = await runLoopShape(iter);
    expect(result.caughtTransient).toBe(true);
    expect(result.reThrew).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("transient network error"));
  });

  it("still re-throws non-transient errors so real bugs surface", async () => {
    const iter: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new TypeError("schema mismatch")),
        };
      },
    };
    await expect(runLoopShape(iter)).rejects.toThrow("schema mismatch");
  });
});
