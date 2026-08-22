/**
 * #556 — the primitives the three bearer-authed listeners (fleet, git transport, MCP bridge)
 * had each hand-rolled. The pruning test is the behaviour CHANGE: the worker registry's
 * pairing map only deleted the entry it consumed, so unclaimed tokens accumulated for the
 * process's lifetime.
 */
import { describe, it, expect } from "vitest";
import { createExpiringDigestStore, extractBearer, mintToken, sha256Hex, envPort } from "../lib/bearer-token.js";

describe("extractBearer (#556)", () => {
  it("reads a Bearer token, case-insensitively and around whitespace", () => {
    expect(extractBearer("Bearer abc123")).toBe("abc123");
    expect(extractBearer("  bearer   abc123 ")).toBe("abc123");
  });

  it("returns null for an absent, array-valued or non-Bearer header", () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer(null)).toBeNull();
    expect(extractBearer(["Bearer a", "Bearer b"])).toBeNull();
    expect(extractBearer("Token abc")).toBeNull();
  });

  it("accepts Basic ONLY when asked, and takes the token from the PASSWORD slot only", () => {
    // git sends `http://x-token:<token>@host`, i.e. the password slot. #753 stopped also
    // accepting it as the USERNAME: that is the half of a credential which gets echoed into
    // `git remote -v`, proxy access logs and error text, while the password half is what
    // tooling knows to redact. A legible 401 is recoverable; a token in a log is not.
    const basic = (raw: string) => `Basic ${Buffer.from(raw).toString("base64")}`;
    expect(extractBearer(basic("x-token:secret"), { allowBasic: true })).toBe("secret");
    expect(extractBearer(basic("secret"), { allowBasic: true })).toBeNull();
    expect(extractBearer(basic("x-token:secret"))).toBeNull();
    // An empty Basic payload has no token in either slot; garbage base64 is not asserted on
    // because Node decodes it to arbitrary bytes rather than throwing.
    expect(extractBearer(basic(":"), { allowBasic: true })).toBeNull();
  });
});

describe("createExpiringDigestStore (#556)", () => {
  it("resolves a live token and never keeps the plaintext", () => {
    const store = createExpiringDigestStore<{ workerId: string }>({ ttlMs: 1000 });
    const token = store.issue({ workerId: "w1" }, { now: 0 });
    expect(store.resolve(token, 500)).toEqual({ workerId: "w1" });
    expect(store.resolve("some-other-token", 500)).toBeNull();
  });

  it("expires by TTL and drops the expired entry on the way out", () => {
    const store = createExpiringDigestStore<string>({ ttlMs: 100 });
    const token = store.issue("scope", { now: 0 });
    expect(store.resolve(token, 100)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("prunes expired entries on every issue — the leak the pairing map had", () => {
    const store = createExpiringDigestStore<string>({ ttlMs: 10 });
    store.issue("stale", { now: 0 });
    store.issue("stale", { now: 0 });
    expect(store.size()).toBe(2);
    store.issue("fresh", { now: 1000 });
    expect(store.size()).toBe(1);
  });

  it("consume is single-use and refuses an expired token", () => {
    const store = createExpiringDigestStore<true>({ ttlMs: 100 });
    const token = store.issue(true, { now: 0 });
    expect(store.consume(token, 50)).toBe(true);
    expect(store.consume(token, 50)).toBeNull();
    const stale = store.issue(true, { now: 0 });
    expect(store.consume(stale, 500)).toBeNull();
  });

  it("revokeWhere drops every entry matching a predicate — revoking one worker", () => {
    const store = createExpiringDigestStore<{ workerId: string }>({ ttlMs: 1000 });
    const keep = store.issue({ workerId: "keep" }, { now: 0 });
    store.issue({ workerId: "gone" }, { now: 0 });
    store.issue({ workerId: "gone" }, { now: 0 });
    expect(store.revokeWhere((s) => s.workerId === "gone")).toBe(2);
    expect(store.resolve(keep, 10)).toEqual({ workerId: "keep" });
  });

  it("a per-issue ttlMs overrides the store default", () => {
    const store = createExpiringDigestStore<string>({ ttlMs: 10 });
    const token = store.issue("s", { now: 0, ttlMs: 1000 });
    expect(store.resolve(token, 500)).toBe("s");
  });
});

describe("mintToken / sha256Hex (#556)", () => {
  it("mints 256 bits of hex and does not repeat", () => {
    const a = mintToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(mintToken());
  });

  it("digests stably", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });
});

describe("envPort (#556)", () => {
  it("keeps the two listeners' DIFFERENT fallbacks — 0 = OS-assigned, null = disabled", () => {
    const git = { fallback: 0, logPrefix: "[git-http]", onInvalid: "using an OS-assigned port" };
    const fleet = { fallback: null, logPrefix: "[fleet-listener]", onInvalid: "stays disabled" };
    expect(envPort("P", git, {})).toBe(0);
    expect(envPort("P", fleet, {})).toBeNull();
    expect(envPort("P", git, { P: "  " })).toBe(0);
  });

  it("parses a valid port and falls back on anything out of range or non-integer", () => {
    expect(envPort("P", { fallback: 0, logPrefix: "[x]", onInvalid: "y" }, { P: "3002" })).toBe(3002);
    for (const bad of ["-1", "65536", "3002.5", "abc"]) {
      expect(envPort("P", { fallback: null, logPrefix: "[x]", onInvalid: "y" }, { P: bad })).toBeNull();
    }
  });
});
