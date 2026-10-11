import { describe, expect, it } from "vitest";
import { fillBootstrapLine, providerCredentials, workerSetupState } from "./workerSetup.js";

const base = { effectiveStatus: "online" as const, providers: ["claude"] };
const doctor = (checks: Array<{ id: string; status: "pass" | "warn" | "fail"; message?: string }>, credential?: "ok" | "missing") => ({
  checks: checks.map((c) => ({ message: "", ...c })),
  checkedAt: "2026-10-11T10:00:00.000Z",
  ...(credential ? { providers: [{ provider: "claude", credential }] } : {}),
});

describe("workerSetupState (#1370)", () => {
  it("a worker with a FAIL needs setup, even though its heartbeat is online", () => {
    const s = workerSetupState({ ...base, doctor: doctor([{ id: "git", status: "fail" }], "ok") });
    expect(s.needsSetup).toBe(true);
    expect(s.reasons).toEqual(["1 failing check"]);
    expect(s.failing.map((c) => c.id)).toEqual(["git"]);
  });

  it("a worker whose only provider has no credentials needs setup", () => {
    const s = workerSetupState({ ...base, doctor: doctor([{ id: "git", status: "pass" }], "missing") });
    expect(s.needsSetup).toBe(true);
    expect(s.reasons).toEqual(["no usable provider"]);
  });

  it("a worker with no provider at all needs setup", () => {
    expect(workerSetupState({ ...base, providers: [] }).reasons).toEqual(["no provider declared"]);
  });

  it("a healthy worker (passes and warnings only) is ready; warnings are listed", () => {
    const s = workerSetupState({ ...base, doctor: doctor([{ id: "a", status: "pass" }, { id: "b", status: "warn" }], "ok") });
    expect(s.needsSetup).toBe(false);
    expect(s.warning.map((c) => c.id)).toEqual(["b"]);
  });

  it("an offline worker is offline, not 'needs setup'", () => {
    expect(workerSetupState({ ...base, effectiveStatus: "offline", providers: [] }).needsSetup).toBe(false);
  });

  it("expired attested profiles override a logged-in CLI", () => {
    const rows = providerCredentials({
      ...base,
      doctor: doctor([], "ok"),
      attestedProfiles: [{ provider: "claude", name: "p1", credentials: "expired" }],
    });
    expect(rows).toEqual([{ provider: "claude", credential: "expired" }]);
  });
});

describe("fillBootstrapLine", () => {
  it("fills the token and the fleet URL the CLI would print", () => {
    const out = fillBootstrapLine('curl -H "Authorization: Bearer <pairing-token>" "http://<board-host>:3002/api/workers/build"', {
      placeholderToken: "<pairing-token>",
      token: "TOK",
      placeholderUrl: "http://<board-host>:3002",
      url: "http://100.1.2.3:3002/",
    });
    expect(out).toBe('curl -H "Authorization: Bearer TOK" "http://100.1.2.3:3002/api/workers/build"');
  });
});
