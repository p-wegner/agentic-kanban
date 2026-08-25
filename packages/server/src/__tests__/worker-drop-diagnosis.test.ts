/**
 * #881 — a crashed worker, a slept machine, a flaky link and a blocked worker all rendered
 * as the same word. These are the cases that must come apart.
 *
 * The last block replays the ACTUAL timeline of `AO-PF38Z8R8` on 2026-08-25, which is what
 * motivated the ticket: three distinct signatures inside one 10-hour history. Pinning the
 * classifier against real rows rather than only against invented ones is the point — the
 * invented cases prove the branches, the real one proves the branches match reality.
 */
import { describe, expect, it } from "vitest";
import { classifyWorkerDrop } from "../services/worker-drop-diagnosis.js";
import type { WorkerEvent } from "@agentic-kanban/shared/types";

let seq = 0;
function ev(type: string, at: string, payload: Record<string, unknown> | null = null): WorkerEvent {
  seq += 1;
  return {
    id: "e" + String(seq),
    workerId: "w1",
    type,
    sessionId: null,
    summary: type,
    payload,
    createdAt: at,
  };
}

const online = (at: string) => ev("status_change", at, { from: "offline", to: "online" });
const offline = (at: string) => ev("status_change", at, { from: "online", to: "offline" });
const up = (at: string) => ev("connected", at);
const down = (at: string) => ev("disconnected", at);

/** Epoch ms for an ISO instant, so the tests never hardcode a clock offset. */
const ms = (iso: string) => Date.parse(iso);

describe("classifyWorkerDrop", () => {
  it("says so honestly when there is nothing to go on", () => {
    const d = classifyWorkerDrop([], { nowMs: ms("2026-08-25T03:00:00Z") });
    expect(d.cause).toBe("insufficient-data");
    expect(d.confidence).toBe("low");
  });

  it("ignores rows that carry no transport meaning", () => {
    const d = classifyWorkerDrop([ev("assigned", "2026-08-25T02:00:00Z"), ev("ref_held", "2026-08-25T02:01:00Z")], {
      nowMs: ms("2026-08-25T03:00:00Z"),
    });
    expect(d.cause).toBe("insufficient-data");
  });

  it("reports a connected worker with no drops as healthy", () => {
    const d = classifyWorkerDrop([up("2026-08-25T02:00:00Z"), online("2026-08-25T02:00:05Z")], {
      nowMs: ms("2026-08-25T03:00:00Z"),
    });
    expect(d.cause).toBe("healthy");
    expect(d.drops).toBe(0);
  });

  describe("process-gone — the decisive case", () => {
    it("a clean drop with no reconnect attempt reads as a dead process, not patience", () => {
      const d = classifyWorkerDrop(
        [up("2026-08-25T02:20:12Z"), down("2026-08-25T02:21:02Z"), offline("2026-08-25T02:38:46Z")],
        { nowMs: ms("2026-08-25T02:45:00Z") },
      );
      expect(d.cause).toBe("process-gone");
      expect(d.confidence).toBe("high");
      expect(d.reconnectsSinceLastDrop).toBe(0);
      // The headline has to tell the operator to act, since waiting is the wrong move here.
      expect(d.headline).toMatch(/Restart it/i);
    });

    it("does NOT fire while the worker is still inside its normal backoff", () => {
      // 30s after the close, with a 15-22s observed backoff, is mid-reconnect — calling that
      // a dead process would send an operator to a machine that is about to come back.
      const d = classifyWorkerDrop([up("2026-08-25T02:20:12Z"), down("2026-08-25T02:21:02Z")], {
        nowMs: ms("2026-08-25T02:21:32Z"),
      });
      expect(d.cause).not.toBe("process-gone");
    });

    it("a reconnect after the drop rules it out however long ago the drop was", () => {
      const d = classifyWorkerDrop(
        [up("2026-08-25T01:00:00Z"), down("2026-08-25T01:10:00Z"), up("2026-08-25T01:10:20Z")],
        { nowMs: ms("2026-08-25T05:00:00Z") },
      );
      expect(d.cause).not.toBe("process-gone");
      expect(d.reconnectsSinceLastDrop).toBe(1);
    });
  });

  describe("ordering separates a blocked worker from an unreachable one", () => {
    it("offline BEFORE the close is a heartbeat stall, and points at the worker", () => {
      const d = classifyWorkerDrop(
        [
          up("2026-08-25T02:00:00Z"),
          online("2026-08-25T02:00:10Z"),
          offline("2026-08-25T02:01:10Z"),
          down("2026-08-25T02:01:10Z"),
          up("2026-08-25T02:01:26Z"),
        ],
        { nowMs: ms("2026-08-25T02:02:00Z") },
      );
      expect(d.cause).toBe("heartbeat-stall");
      expect(d.headline).toMatch(/blocked or overloaded, not unreachable/i);
    });

    it("offline AFTER the close is just the deadline noticing, not a stall", () => {
      // Same two rows, opposite order. This is the ordinary network-drop shape and must not
      // be reported as a blocked worker.
      const d = classifyWorkerDrop(
        [
          up("2026-08-25T02:00:00Z"),
          down("2026-08-25T02:01:10Z"),
          offline("2026-08-25T02:02:10Z"),
          up("2026-08-25T02:02:20Z"),
        ],
        { nowMs: ms("2026-08-25T02:03:00Z") },
      );
      expect(d.cause).not.toBe("heartbeat-stall");
    });
  });

  describe("periodicity separates a timer from weather", () => {
    it("tight, regular reconnects read as a mechanism", () => {
      const events: WorkerEvent[] = [];
      // Six cycles, reconnecting after 15-17s every time — the observed sawtooth.
      const gaps = [15, 16, 17, 15, 16, 16];
      let t = Date.parse("2026-08-25T02:00:00Z");
      for (const gap of gaps) {
        events.push(up(new Date(t).toISOString()));
        t += 60_000;
        events.push(down(new Date(t).toISOString()));
        t += gap * 1000;
      }
      events.push(up(new Date(t).toISOString()));
      const d = classifyWorkerDrop(events, { nowMs: t + 5_000 });
      expect(d.cause).toBe("cycling");
      expect(d.reconnectRegular).toBe(true);
      expect(d.headline).toMatch(/not a flaky network/i);
    });

    it("scattered reconnects read as a genuinely unreliable link", () => {
      const events: WorkerEvent[] = [];
      const gaps = [3, 240, 17, 600]; // wildly irregular — weather
      let t = Date.parse("2026-08-25T02:00:00Z");
      for (const gap of gaps) {
        events.push(up(new Date(t).toISOString()));
        t += 60_000;
        events.push(down(new Date(t).toISOString()));
        t += gap * 1000;
      }
      events.push(up(new Date(t).toISOString()));
      const d = classifyWorkerDrop(events, { nowMs: t + 5_000 });
      expect(d.cause).toBe("flapping");
      expect(d.reconnectRegular).toBe(false);
    });

    it("refuses to claim periodicity from too few samples", () => {
      const d = classifyWorkerDrop(
        [up("2026-08-25T02:00:00Z"), down("2026-08-25T02:01:00Z"), up("2026-08-25T02:01:15Z")],
        { nowMs: ms("2026-08-25T02:02:00Z") },
      );
      // Null, NOT false — "measured and irregular" would be a different and untrue claim.
      expect(d.reconnectRegular).toBeNull();
    });
  });

  describe("pairing exposes sockets that reopen without closing", () => {
    it("consecutive connects with no close are counted and reported", () => {
      const d = classifyWorkerDrop(
        [
          up("2026-08-25T00:10:18Z"),
          up("2026-08-25T00:17:15Z"),
          up("2026-08-25T00:23:04Z"),
          up("2026-08-25T00:25:44Z"),
        ],
        { nowMs: ms("2026-08-25T00:30:00Z") },
      );
      expect(d.unpairedConnects).toBe(3);
      expect(d.cause).toBe("silent-respawn");
    });

    it("an opens-only window is never reported as healthy", () => {
      // The trap: no `disconnected` row could naively read as "no drops, all good", when it
      // is in fact the respawn signature.
      const d = classifyWorkerDrop([up("2026-08-25T00:10:00Z"), up("2026-08-25T00:12:00Z"), up("2026-08-25T00:14:00Z")], {
        nowMs: ms("2026-08-25T00:20:00Z"),
      });
      expect(d.cause).not.toBe("healthy");
    });

    it("properly paired cycles report no churn", () => {
      const d = classifyWorkerDrop(
        [
          up("2026-08-25T02:00:00Z"),
          down("2026-08-25T02:01:00Z"),
          up("2026-08-25T02:01:15Z"),
          down("2026-08-25T02:02:15Z"),
          up("2026-08-25T02:02:31Z"),
        ],
        { nowMs: ms("2026-08-25T02:03:00Z") },
      );
      expect(d.unpairedConnects).toBe(0);
    });
  });

  it("accepts newest-first rows, the order listWorkerEvents actually returns", () => {
    const oldestFirst = [up("2026-08-25T02:20:12Z"), down("2026-08-25T02:21:02Z"), offline("2026-08-25T02:38:46Z")];
    const at = { nowMs: ms("2026-08-25T02:45:00Z") };
    expect(classifyWorkerDrop([...oldestFirst].reverse(), at)).toEqual(classifyWorkerDrop(oldestFirst, at));
  });

  describe("the real AO-PF38Z8R8 history (2026-08-25)", () => {
    /** The 60s sawtooth, 16:24-16:58Z — eighteen unbroken cycles. */
    function sawtooth(): WorkerEvent[] {
      const events: WorkerEvent[] = [];
      let t = Date.parse("2026-08-24T16:24:18Z");
      const gaps = [15, 17, 19, 15, 16, 18, 16, 19, 18, 20, 18, 22, 21, 23, 19, 21, 22];
      events.push(online(new Date(t).toISOString()));
      for (const gap of gaps) {
        t += 60_000;
        events.push(offline(new Date(t).toISOString()));
        events.push(down(new Date(t).toISOString()));
        t += gap * 1000;
        events.push(up(new Date(t).toISOString()));
        t += 45_000 - gap * 1000;
        events.push(online(new Date(t).toISOString()));
      }
      return events;
    }

    it("signature A: the sawtooth is diagnosed as a stall, not as a bad link", () => {
      const events = sawtooth();
      const last = Date.parse(events[events.length - 1]!.createdAt);
      const d = classifyWorkerDrop(events, { nowMs: last + 10_000 });
      // Offline consistently precedes the close, so the worker was reachable and silent.
      expect(d.cause).toBe("heartbeat-stall");
      expect(d.drops).toBe(17);
      // And the periodicity is visible in the numbers even though it did not decide the verdict.
      expect(d.reconnectRegular).toBe(true);
    });

    it("signature C: the live drop is a dead process, and says to restart it", () => {
      const d = classifyWorkerDrop(
        [
          up("2026-08-25T01:12:19Z"),
          up("2026-08-25T02:20:12Z"),
          down("2026-08-25T02:21:02Z"),
          offline("2026-08-25T02:38:46Z"),
        ],
        { nowMs: ms("2026-08-25T02:43:00Z") },
      );
      expect(d.cause).toBe("process-gone");
      expect(d.reconnectsSinceLastDrop).toBe(0);
      expect(d.lastDropAt).toBe("2026-08-25T02:21:02Z");
      // Signature B is still visible in the evidence even though C decided the headline.
      expect(d.unpairedConnects).toBe(1);
    });
  });
});
