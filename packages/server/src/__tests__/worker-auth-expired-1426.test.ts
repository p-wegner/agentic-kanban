import { describe, expect, it } from "vitest";
import { authExpiredProfileNames, describeAuthExpired } from "../lib/worker-profile-attestation.js";
import { classifyAssignFailure } from "../services/worker-connection.service.js";
import { AUTH_EXPIRED_PREFIX, AUTH_FAILURE_PATTERN } from "../worker/worker-profiles.js";

describe("#1426 auth-expired worker", () => {
  it("names a provider only when every attested login for it is auth-expired", () => {
    const dead = { provider: "claude", name: "anth", credentials: "auth-expired" as const };
    expect(authExpiredProfileNames([dead], "claude")).toEqual(["anth"]);
    expect(authExpiredProfileNames([dead, { provider: "claude", name: "team" }], "claude")).toEqual([]);
    expect(authExpiredProfileNames([dead], "codex")).toEqual([]);
    expect(authExpiredProfileNames(undefined, "claude")).toEqual([]);
  });

  it("renders the attention line", () => {
    expect(describeAuthExpired("wsl-stable", "claude", ["anth"])).toBe(
      "wsl-stable: claude login expired (anth) - re-login or copy credentials",
    );
  });

  it("detects the result line and classifies the assign_failed", () => {
    expect(AUTH_FAILURE_PATTERN.test("Failed to authenticate: OAuth session expired and could not be refreshed")).toBe(true);
    expect(classifyAssignFailure(`${AUTH_EXPIRED_PREFIX} (anth): the agent could not authenticate`)).toBe("auth-expired");
  });
});
