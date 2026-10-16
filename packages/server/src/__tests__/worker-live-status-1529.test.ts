import { describe, it, expect } from "vitest";
import { deriveLiveStatus, DISCONNECT_GRACE_MS } from "../services/placement-explain.service.js";

describe("deriveLiveStatus (#1529)", () => {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const ago = (ms: number) => new Date(nowMs - ms).toISOString();

  it("keeps the effective status while a socket is held", () => {
    expect(deriveLiveStatus("online", true, ago(10_000), now)).toBe("online");
    expect(deriveLiveStatus("draining", true, ago(10_000), now)).toBe("draining");
  });

  it("tolerates a short gap with no socket", () => {
    expect(deriveLiveStatus("online", false, ago(DISCONNECT_GRACE_MS - 1000), now)).toBe("online");
  });

  it("reads offline once disconnected beyond the grace", () => {
    expect(deriveLiveStatus("online", false, ago(DISCONNECT_GRACE_MS + 1000), now)).toBe("offline");
    expect(deriveLiveStatus("online", false, null, now)).toBe("offline");
  });

  it("stays offline when the heartbeat is already stale", () => {
    expect(deriveLiveStatus("offline", true, ago(3_600_000), now)).toBe("offline");
  });
});
