import { describe, expect, it } from "vitest";
import { isLoopbackAddress, rejectNonLoopback } from "./devProxyGuard";

describe("isLoopbackAddress", () => {
  it("accepts IPv4 loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  });

  it("accepts IPv6 loopback", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
  });

  it("accepts the IPv4-mapped IPv6 loopback address a dual-stack socket reports", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects a tailnet address", () => {
    expect(isLoopbackAddress("100.105.24.76")).toBe(false);
  });

  it("rejects an IPv4-mapped tailnet address", () => {
    expect(isLoopbackAddress("::ffff:100.105.24.76")).toBe(false);
  });

  it("rejects a LAN address", () => {
    expect(isLoopbackAddress("192.168.1.42")).toBe(false);
  });

  it("rejects a missing address", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe("rejectNonLoopback", () => {
  function reqWith(remoteAddress: string | undefined) {
    return { socket: { remoteAddress } } as unknown as Parameters<typeof rejectNonLoopback>[0];
  }

  it("lets a loopback-originated request through (returns undefined)", () => {
    expect(rejectNonLoopback(reqWith("127.0.0.1"))).toBeUndefined();
  });

  it("blocks a request from a tailnet peer (returns false)", () => {
    expect(rejectNonLoopback(reqWith("100.105.24.76"))).toBe(false);
  });

  it("blocks a request with no socket remote address", () => {
    expect(rejectNonLoopback({ socket: {} } as unknown as Parameters<typeof rejectNonLoopback>[0])).toBe(false);
  });
});
