import { describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { maybeStartIpv6CompanionListener } from "../startup/ipv6-companion-listener.js";

/**
 * Characterization tests for the IPv6 companion-listener gate, extracted out
 * of server-start.ts (#873). Pins the two conditions under which the board
 * must NOT open the `::1` companion listener: TLS is active, or the primary
 * host isn't the IPv4 loopback default. The actual bind (`serve()`) is not
 * exercised here — this is the decision, not the socket.
 */
describe("maybeStartIpv6CompanionListener", () => {
  const app = {} as Hono;
  const injectWebSocket = vi.fn();

  it("skips when TLS is active", () => {
    const result = maybeStartIpv6CompanionListener(app, "127.0.0.1", 3001, true, injectWebSocket);
    expect(result).toBeNull();
  });

  it("skips when the host is not the IPv4 loopback default", () => {
    const result = maybeStartIpv6CompanionListener(app, "0.0.0.0", 3001, false, injectWebSocket);
    expect(result).toBeNull();
  });

  it("skips when the host is a custom KANBAN_HOST value", () => {
    const result = maybeStartIpv6CompanionListener(app, "192.168.1.5", 3001, false, injectWebSocket);
    expect(result).toBeNull();
  });
});
