/**
 * #1027 — worker profile ATTESTATION: the wire shape, and the decision it feeds.
 *
 * What is pinned here, and why each one is a property someone could plausibly break:
 *  - The protocol BUMPED to 2 but still accepts a protocol-1 (and a version-less) worker.
 *    The bump is what makes skew visible; raising the floor with it would refuse machines
 *    that work perfectly, which is the #754 trap this ticket must not walk back into.
 *  - An attestation off the wire is PARSED, never trusted: a half-understood entry is
 *    dropped rather than coerced, because here an entry becomes a dispatch permission.
 *  - `forbidden` wins on either side. A worker cannot lift a project's restriction by
 *    declaring a friendlier role, and a globally-forbidden account stays forbidden.
 *  - A profile the worker does NOT attest is dropped from the roster: offering it would
 *    place work the worker then has to reject.
 *  - Ordering inside `pool` follows the worker's own quota reading, and an unknown/stale
 *    reading sorts last WITHOUT being treated as exhausted (old beats wrong).
 */
import { describe, it, expect } from "vitest";
import {
  MIN_SUPPORTED_WORKER_PROTOCOL_VERSION,
  WORKER_PROTOCOL_VERSION,
  checkProtocolCompatibility,
  parseWorkerCapabilities,
  parseWorkerProfileAttestations,
  parseWorkerToBoardMessage,
  type WorkerProfileAttestation,
} from "@agentic-kanban/shared/lib/worker-protocol";
import {
  headroomFromAttestations,
  intersectRosterWithAttestation,
  selectAttestedProfile,
} from "../lib/worker-profile-attestation.js";
import { parseRoster, resolveProjectRoster } from "@agentic-kanban/shared/lib/profile-roster";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

function attest(
  name: string,
  role?: string,
  usedPct5h?: number | null,
): WorkerProfileAttestation {
  return {
    provider: "claude",
    name,
    ...(role ? { role } : {}),
    ...(usedPct5h === undefined
      ? {}
      : { quota: { usedPct5h, usedPct7d: null, measuredAt: new Date(NOW).toISOString(), stale: usedPct5h === null } }),
  };
}

describe("protocol version (#1027 bumps, #754 compatibility stands)", () => {
  it("is 2, with the floor left at 1", () => {
    expect(WORKER_PROTOCOL_VERSION).toBe(2);
    expect(MIN_SUPPORTED_WORKER_PROTOCOL_VERSION).toBe(1);
  });

  it("still accepts a protocol-1 worker and a version-less one", () => {
    // `profiles` is an optional capability field, so an older worker speaks a protocol the
    // board can still honour — it simply attests nothing, and a restricted project keeps
    // getting #651's refusal for it. Refusing it instead would break working machines for
    // a feature they are not using.
    expect(checkProtocolCompatibility(1)).toEqual({ ok: true, version: 1 });
    expect(checkProtocolCompatibility(undefined)).toEqual({ ok: true, version: 1 });
    expect(checkProtocolCompatibility(2)).toEqual({ ok: true, version: 2 });
  });

  it("still refuses a worker NEWER than the board", () => {
    const verdict = checkProtocolCompatibility(3);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/NEWER than this board/);
  });
});

describe("parsing an attestation off the wire", () => {
  it("keeps well-formed entries, with role and quota", () => {
    const parsed = parseWorkerProfileAttestations([
      { provider: "claude", name: "anth", role: "pool", quota: { usedPct5h: 12, stale: false } },
      { provider: "codex", name: "team5x", role: "reserve", dedicatedProject: "acme" },
    ]);
    expect(parsed).toEqual([
      { provider: "claude", name: "anth", role: "pool", quota: { usedPct5h: 12, stale: false } },
      { provider: "codex", name: "team5x", role: "reserve", dedicatedProject: "acme" },
    ]);
  });

  it("drops what it cannot understand rather than coercing it", () => {
    // An attestation becomes a PERMISSION, so a guess here is a guess about which client's
    // subscription pays for the work.
    expect(parseWorkerProfileAttestations([{ provider: "claude" }, { name: "x" }, 7, null])).toBeUndefined();
    expect(parseWorkerProfileAttestations("anth")).toBeUndefined();
    expect(parseWorkerProfileAttestations(undefined)).toBeUndefined();
    // Deduped by provider:name — a repeated entry is not two permissions.
    expect(parseWorkerProfileAttestations([
      { provider: "claude", name: "anth" },
      { provider: "claude", name: "anth", role: "forbidden" },
    ])).toEqual([{ provider: "claude", name: "anth" }]);
  });

  it("rides the capabilities blob on hello and on the heartbeat alike", () => {
    const capabilities = parseWorkerCapabilities({
      providers: ["claude"],
      profiles: [{ provider: "claude", name: "anth" }],
    });
    expect(capabilities?.profiles).toEqual([{ provider: "claude", name: "anth" }]);

    const hello = parseWorkerToBoardMessage(
      JSON.stringify({
        type: "hello",
        workerId: "w1",
        runningSessionIds: [],
        protocolVersion: 2,
        capabilities: { profiles: [{ provider: "claude", name: "anth", role: "pool" }] },
      }),
    );
    expect(hello?.type).toBe("hello");
    if (hello?.type !== "hello") throw new Error("unreachable");
    expect(hello.capabilities?.profiles).toEqual([{ provider: "claude", name: "anth", role: "pool" }]);
  });

  it("a capabilities blob carrying ONLY profiles is still a capabilities blob", () => {
    // Regression guard for the "all fields absent -> undefined" short-circuit: a worker
    // that declares nothing but its profiles must not have them thrown away.
    expect(parseWorkerCapabilities({ profiles: [{ provider: "claude", name: "anth" }] })).toEqual({
      profiles: [{ provider: "claude", name: "anth" }],
    });
  });
});

describe("intersecting a project roster with what a worker attests", () => {
  const roster = parseRoster('["claude:anth","claude:team5x"]');

  it("drops a rostered profile the worker cannot authenticate as", () => {
    const intersected = intersectRosterWithAttestation(roster, [attest("anth")]);
    expect(intersected.entries.map((e) => e.name)).toEqual(["anth"]);
  });

  it("takes the MORE restrictive of the two roles", () => {
    const projectRoster = parseRoster('[{"provider":"claude","name":"anth","role":"pool"}]');
    const intersected = intersectRosterWithAttestation(projectRoster, [attest("anth", "forbidden")]);
    expect(intersected.entries[0].role).toBe("forbidden");

    // ... and the other direction: a worker calling a project-forbidden account `pool`
    // does not make it usable.
    const forbiddenByProject = parseRoster('[{"provider":"claude","name":"anth","role":"forbidden"}]');
    expect(intersectRosterWithAttestation(forbiddenByProject, [attest("anth", "pool")]).entries[0].role)
      .toBe("forbidden");
  });

  it("an OPEN roster still lets an unlisted attested profile be ordinary supply", () => {
    // Only the observed global roles bite here: a board where somebody marked ONE account
    // forbidden must not thereby restrict every other account to nothing.
    const open = resolveProjectRoster({
      globalRoster: [{ provider: "claude", name: "banned", role: "forbidden" }],
    });
    expect(open.restricted).toBe(true);
    expect(open.closed).toBe(false);
    const intersected = intersectRosterWithAttestation(open, [attest("anth")]);
    expect(intersected.entries.map((e) => `${e.name}:${e.role}`)).toContain("anth:pool");
  });
});

describe("selecting the profile a worker would run under", () => {
  const roster = parseRoster('["claude:anth","claude:team5x"]');
  const base = { roster, prefMap: new Map<string, string>(), nowMs: NOW };

  it("prefers the attested profile with the most headroom left", () => {
    const result = selectAttestedProfile({
      ...base,
      attestations: [attest("anth", "pool", 80), attest("team5x", "pool", 10)],
    });
    expect(result.selection?.name).toBe("team5x");
    expect(result.holdReason).toBeNull();
  });

  it("treats an UNKNOWN reading as unknown, never as exhausted", () => {
    // The profile with no measurement sorts behind the measured one but stays selectable —
    // dropping it would take a perfectly usable account out of rotation on missing data.
    const result = selectAttestedProfile({ ...base, attestations: [attest("anth")] });
    expect(result.selection?.name).toBe("anth");
    expect(headroomFromAttestations([attest("anth")]).get("claude:anth")).toEqual({
      usedPct: null,
      stale: true,
    });
  });

  it("gives nothing to a worker attesting only a FORBIDDEN profile", () => {
    const result = selectAttestedProfile({ ...base, attestations: [attest("anth", "forbidden")] });
    expect(result.selection).toBeNull();
    expect(result.holdReason).toMatch(/cooling|exhausted|forbidden/);
  });

  it("gives nothing to a worker attesting nothing at all", () => {
    expect(selectAttestedProfile({ ...base, attestations: [] }).selection).toBeNull();
    expect(selectAttestedProfile({ ...base, attestations: undefined }).selection).toBeNull();
  });

  it("withholds a reserve profile unless the project allows it", () => {
    const reserveRoster = parseRoster('[{"provider":"claude","name":"break-glass","role":"reserve"}]');
    const withheld = selectAttestedProfile({
      ...base,
      roster: reserveRoster,
      attestations: [attest("break-glass", "reserve")],
    });
    expect(withheld.selection).toBeNull();
    expect(withheld.holdReason).toMatch(/reserve/);

    const allowed = selectAttestedProfile({
      ...base,
      roster: reserveRoster,
      attestations: [attest("break-glass", "reserve")],
      reserveAllowed: true,
    });
    expect(allowed.selection?.name).toBe("break-glass");
    expect(allowed.usedReserve).toBe(true);
  });
});
