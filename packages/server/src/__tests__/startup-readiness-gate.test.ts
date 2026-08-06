// @covers platform.startup.readiness [resilience,workflow]
/**
 * The readiness gate that makes binding the port early SAFE (#282).
 *
 * `serve()` used to be the last statement of a long serial prologue, so the board answered
 * nothing for 238 s after a restart — and `tsx watch` restarts on every server-source edit,
 * so that was paid repeatedly while working on the board itself. The listener now comes up
 * first and the git-spawning reconcilers run behind it.
 *
 * That trade is only acceptable with a gate: those reconcilers repair state a mutating
 * request would otherwise act on (an unaborted rebase, a silently-merged workspace not yet
 * closed, an orphan service stack not yet reclaimed — the ordering constraint documented at
 * the old `reapOrphanServiceStacksOnce` call site). So reads go through immediately and
 * writes wait. These tests pin exactly that asymmetry, plus the two ways it must not be
 * able to wedge the board: it stops gating once startup completes, and it gives up waiting
 * rather than holding a write forever if the deferred phase hangs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import {
  createStartupReadinessGate,
  isStartupComplete,
  markStartupComplete,
  resetStartupReadiness,
  whenStartupComplete,
} from "../startup/readiness.js";

function appWithGate(gate = createStartupReadinessGate()) {
  const app = new Hono();
  app.use("/api/*", gate);
  app.get("/api/board", (c) => c.json({ ok: true }));
  app.post("/api/workspaces", (c) => c.json({ created: true }, 201));
  return app;
}

describe("startup readiness gate (#282)", () => {
  beforeEach(() => {
    resetStartupReadiness();
  });

  it("serves a READ immediately while the deferred startup phase is still running", async () => {
    const app = appWithGate();

    // Nothing has marked startup complete — this must not hang.
    const res = await app.request("/api/board");

    expect(res.status).toBe(200);
    expect(isStartupComplete()).toBe(false);
  });

  it("holds a WRITE until the deferred phase completes, then lets it through", async () => {
    const app = appWithGate();
    const handled = vi.fn();

    const pending = app.request("/api/workspaces", { method: "POST" }).then((res) => {
      handled();
      return res;
    });

    // Give the request a chance to resolve if the gate were not holding it.
    await new Promise((r) => setTimeout(r, 20));
    expect(handled).not.toHaveBeenCalled();

    markStartupComplete();
    const res = await pending;

    expect(res.status).toBe(201);
  });

  it("stops gating once startup is complete — no per-request wait afterwards", async () => {
    markStartupComplete();
    const waitFor = vi.fn(async () => {});
    const app = appWithGate(createStartupReadinessGate({ waitFor }));

    const res = await app.request("/api/workspaces", { method: "POST" });

    expect(res.status).toBe(201);
    expect(waitFor).not.toHaveBeenCalled();
  });

  it("proceeds anyway when the deferred phase hangs, rather than wedging writes forever", async () => {
    // A git call that never returns (the #254 failure mode) must not make the board
    // permanently unwritable — proceeding is the pre-#282 behaviour, so it is no worse.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = appWithGate(createStartupReadinessGate({
      timeoutMs: 10,
      waitFor: () => new Promise<void>(() => {}),
      isComplete: () => false,
    }));

    const res = await app.request("/api/workspaces", { method: "POST" });

    expect(res.status).toBe(201);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("readiness gate timed out"));
    warn.mockRestore();
  });

  it("markStartupComplete is idempotent and resolves waiters exactly once", async () => {
    const resolved = vi.fn();
    void whenStartupComplete().then(resolved);

    markStartupComplete();
    markStartupComplete();
    await new Promise((r) => setTimeout(r, 0));

    expect(resolved).toHaveBeenCalledTimes(1);
    expect(isStartupComplete()).toBe(true);
    // Already-complete callers get an immediately-resolved promise, not the stale one.
    await expect(whenStartupComplete()).resolves.toBeUndefined();
  });
});
