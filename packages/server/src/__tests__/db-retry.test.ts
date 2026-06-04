import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withDbRetry } from "../db/retry.js";

describe("withDbRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the result on the happy path without retrying", async () => {
    const op = vi.fn(async () => 42);
    const result = await withDbRetry(op, "test op");
    expect(result).toBe(42);
    expect(op).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("retries on SQLITE_BUSY (code) and succeeds on second attempt", async () => {
    const busyErr = Object.assign(new Error("SQLITE_BUSY: database is locked"), {
      code: "SQLITE_BUSY",
    });
    const op = vi.fn().mockRejectedValueOnce(busyErr).mockResolvedValueOnce("ok");

    const promise = withDbRetry(op, "merge workspace");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[db-busy]")
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("attempt 1/3")
    );
  });

  it("retries on EBUSY (code) and succeeds", async () => {
    const busyErr = Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    const op = vi.fn().mockRejectedValueOnce(busyErr).mockResolvedValueOnce(7);

    const promise = withDbRetry(op);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(7);
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("retries on 'database is locked' message and succeeds", async () => {
    const busyErr = new Error("database is locked");
    const op = vi.fn().mockRejectedValueOnce(busyErr).mockResolvedValueOnce("done");

    const promise = withDbRetry(op, "board query");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("done");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 attempts and re-throws", async () => {
    const busyErr = Object.assign(new Error("SQLITE_BUSY"), { code: "SQLITE_BUSY" });
    const op = vi.fn().mockRejectedValue(busyErr);

    const promise = withDbRetry(op, "failing query");
    // Suppress unhandled-rejection noise while timers advance
    promise.catch(() => null);
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow("SQLITE_BUSY");
    expect(op).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("giving up after 3 attempts")
    );
  });

  it("does not retry non-busy errors", async () => {
    const otherErr = new Error("SQLITE_CONSTRAINT");
    const op = vi.fn().mockRejectedValue(otherErr);

    await expect(withDbRetry(op, "constraint op")).rejects.toThrow("SQLITE_CONSTRAINT");
    expect(op).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs context label in [db-busy] lines", async () => {
    const busyErr = Object.assign(new Error("SQLITE_BUSY"), { code: "SQLITE_BUSY" });
    const op = vi.fn().mockRejectedValue(busyErr);

    const promise = withDbRetry(op, "merge workspace abc-123");
    promise.catch(() => null);
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow();

    const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
    expect(calls.some((c) => c.includes("merge workspace abc-123"))).toBe(true);
  });
});
