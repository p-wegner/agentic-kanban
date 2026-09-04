/**
 * #1027 — a profile-restricted project may go remote, but ONLY to a worker that attests.
 *
 * #651 refused it outright, and the reason was factual: the board sends no credentials
 * (decision 012), so it could pick a permitted profile and could not make the worker
 * honour it. This suite pins the four placement outcomes that narrowing produces, plus
 * the two halves that keep it honest — the worker REJECTING a profile it does not hold,
 * and that rejection arriving on the board as a nameable dispatch failure.
 *
 * Deliberately built on `worker-allowlist-enforcement.test.ts`'s fixture, because the
 * #651 behaviour it pins must survive intact for a worker that attests nothing — which is
 * every worker built before this ticket.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preferences, projects as projectsTable } from "@agentic-kanban/shared/schema";
import { allowedProfilesPrefKey } from "@agentic-kanban/shared/lib/profile-allowlist";
import type { WorkerLaunchSpec } from "@agentic-kanban/shared/lib/worker-protocol";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import type { WSContext } from "hono/ws";
import {
  getWorkerFleet,
  resolveWorkerPlacement,
  projectCanDispatch,
  workerDispatchPrefKey,
  workerStrictPrefKey,
  SHARES_FILESYSTEM_LABEL,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";
import { classifyAssignFailure } from "../services/worker-connection.service.js";
import {
  PROFILE_UNKNOWN_PREFIX,
  applyProfileToSpec,
  narrowDeclaredProfiles,
  quotaPollableProfiles,
} from "../worker/worker-profiles.js";
import { discoverLocalProfiles } from "../lib/local-profile-discovery.js";

const PROJECT_ID = "cccc1111-2222-3333-4444-555566667777";
const ALLOWED = JSON.stringify([
  { provider: "claude", name: "andrena_team_5x" },
  { provider: "claude", name: "andrena_team_5x_2" },
]);

describe("placement with worker profile attestation (#1027)", () => {
  let db: Database;
  let fleet: WorkerFleet;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  async function pref(key: string, value: string) {
    await db.insert(preferences).values({ key, value });
  }

  async function seedProject() {
    await db.insert(projectsTable).values({
      id: PROJECT_ID,
      name: "attestation-fixture",
      repoPath: "C:/some/repo",
      defaultBranch: "master",
    } as typeof projectsTable.$inferInsert);
  }

  async function registerWorker(profiles?: Array<{ provider: string; name: string; role?: string }>) {
    const { pairingToken } = fleet.registry.mintPairingToken();
    const result = await fleet.registry.registerWorker({
      pairingToken,
      name: "w",
      labels: [SHARES_FILESYSTEM_LABEL],
      ...(profiles ? { profiles } : {}),
    });
    if (!result.ok) throw new Error(result.error);
    fleet.connections.handleOpen(result.workerId, { send: () => {}, close: () => {} } as unknown as WSContext);
    return result.workerId;
  }

  const placement = () =>
    resolveWorkerPlacement({
      database: db,
      projectId: PROJECT_ID,
      providerName: "claude",
      branch: "feature/ak-1027",
    });

  it("dispatches remotely and PINS the profile when the worker attests a permitted one", async () => {
    await seedProject();
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(allowedProfilesPrefKey(PROJECT_ID), ALLOWED);
    const workerId = await registerWorker([{ provider: "claude", name: "andrena_team_5x", role: "pool" }]);

    const result = await placement();

    expect(result.kind).toBe("remote");
    if (result.kind !== "remote") throw new Error("unreachable");
    expect(result.workerId).toBe(workerId);
    // The NAME travels, and only the name — this is what the worker resolves locally.
    expect(result.profile).toEqual({ provider: "claude", name: "andrena_team_5x" });
  });

  it("keeps #651's host fallback when the worker attests NOTHING (every pre-#1027 worker)", async () => {
    await seedProject();
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(allowedProfilesPrefKey(PROJECT_ID), ALLOWED);
    await registerWorker();

    const result = await placement();

    expect(result.kind).toBe("host");
    expect(result.reason?.id).toBe("profile_allowlist");
    // The refusal now says what it looked for, so an operator can act on the OTHER machine.
    expect(result.reason?.detail).toMatch(/attests/);
  });

  it("gives nothing to a worker attesting only a FORBIDDEN profile — whatever its providers say", async () => {
    await seedProject();
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(allowedProfilesPrefKey(PROJECT_ID), ALLOWED);
    // It attests a profile the project lists, but the ACCOUNT says never-touch. `forbidden`
    // wins over any local claim, so this must be indistinguishable from attesting nothing.
    await registerWorker([{ provider: "claude", name: "andrena_team_5x", role: "forbidden" }]);

    const result = await placement();

    expect(result.kind).toBe("host");
    expect(result.reason?.id).toBe("profile_allowlist");
  });

  it("HOLDS instead of borrowing the host when the project is strict and nothing attests", async () => {
    await seedProject();
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(workerStrictPrefKey(PROJECT_ID), "true");
    await pref(allowedProfilesPrefKey(PROJECT_ID), ALLOWED);
    await registerWorker([{ provider: "claude", name: "some_other_account" }]);

    // The refusal carries the roster, not a capacity story — those need different fixes.
    await expect(placement()).rejects.toThrow(/restricted to|attests/);
  });

  it("tells the monitor a strict project CAN dispatch once a worker attests", async () => {
    await seedProject();
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(workerStrictPrefKey(PROJECT_ID), "true");
    await pref(allowedProfilesPrefKey(PROJECT_ID), ALLOWED);
    await registerWorker([{ provider: "claude", name: "andrena_team_5x" }]);

    // Without this the monitor would skip the start with the #651 reason for work a worker
    // can legitimately take — the placement and the pre-check must give the same answer.
    expect(await projectCanDispatch({ database: db, projectId: PROJECT_ID, providerName: "claude" }))
      .toEqual({ available: true });
  });

  it("leaves an UNRESTRICTED project's placement untouched, with no profile pinned", async () => {
    await seedProject();
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await registerWorker([{ provider: "claude", name: "andrena_team_5x" }]);

    const result = await placement();

    expect(result.kind).toBe("remote");
    if (result.kind !== "remote") throw new Error("unreachable");
    // Nothing restricts anything, so nothing is pinned — the worker keeps choosing its own
    // login exactly as it did before this ticket.
    expect(result.profile).toBeUndefined();
  });
});

describe("the worker's own half: resolve the pinned profile, or refuse (#1027)", () => {
  function fakeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "ak-1027-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings_apikey.json"), JSON.stringify({ env: {} }));
    mkdirSync(join(home, ".claude-oauth"), { recursive: true });
    writeFileSync(join(home, ".claude-oauth", ".credentials.json"), "{}");
    // A directory with no login at all is NOT a profile — attesting it would advertise an
    // account this machine cannot actually authenticate as.
    mkdirSync(join(home, ".claude-empty"), { recursive: true });
    return home;
  }

  const spec = (profile?: string): WorkerLaunchSpec => ({
    command: "claude",
    args: ["--print"],
    env: {},
    cwd: "/work",
    intent: { provider: "claude", program: "claude", ...(profile ? { profile } : {}) },
  });

  it("discovers both carrier shapes and skips a directory with no login", () => {
    const found = discoverLocalProfiles(fakeHome());
    expect(found.map((p) => `${p.name}:${p.kind}`).sort()).toEqual([
      "apikey:claude-settings",
      "oauth:claude-config-dir",
    ]);
  });

  it("selects an OAuth profile by config dir and an API-key profile by --settings", () => {
    const home = fakeHome();
    const oauth = applyProfileToSpec(spec("oauth"), { home });
    expect(oauth.ok).toBe(true);
    if (!oauth.ok) throw new Error("unreachable");
    // The env/argv split is the difference between authenticating as the requested account
    // and authenticating as the machine's default one.
    expect(oauth.spec.env.CLAUDE_CONFIG_DIR).toBe(join(home, ".claude-oauth"));
    expect(oauth.spec.args).toEqual(["--print"]);

    const apikey = applyProfileToSpec(spec("apikey"), { home });
    if (!apikey.ok) throw new Error("unreachable");
    expect(apikey.spec.args).toEqual(["--print", "--settings", join(home, ".claude", "settings_apikey.json")]);
    expect(apikey.spec.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("REFUSES a profile this machine does not hold, naming it", () => {
    // The attestation the board placed on has gone stale. Running under another local login
    // would be the silent fallback #651 refused remote dispatch to prevent.
    const refused = applyProfileToSpec(spec("gone"), { home: fakeHome() });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error).toContain(PROFILE_UNKNOWN_PREFIX);
    expect(refused.error).toContain("gone");
  });

  it("passes an unpinned spec through untouched", () => {
    const result = applyProfileToSpec(spec(), { home: fakeHome() });
    if (!result.ok) throw new Error("unreachable");
    expect(result.spec).toEqual(spec());
  });

  it("the board classifies that refusal as profile-unknown, not as a broken worker", () => {
    // `dispatch`/`provisioning` would send an operator to the link or the checkout; the
    // actual fix is on the worker's logins, and the board re-places meanwhile.
    const refused = applyProfileToSpec(spec("gone"), { home: fakeHome() });
    if (refused.ok) throw new Error("unreachable");
    expect(classifyAssignFailure(refused.error)).toBe("profile-unknown");
    expect(classifyAssignFailure("worker at capacity")).toBe("capacity");
  });

  it("narrows a declared --profiles list to what the machine actually holds", () => {
    const home = fakeHome();
    const discovered = discoverLocalProfiles(home);
    const lines: string[] = [];
    const narrowed = narrowDeclaredProfiles(discovered, ["oauth", "not-here"], (l) => lines.push(l));
    expect(narrowed.map((p) => p.name)).toEqual(["oauth"]);
    // Silence would leave an operator waiting for work that is never dispatched here.
    expect(lines.join("\n")).toContain("not-here");

    // No flag at all = attest what discovery found; `none` = attest nothing.
    expect(narrowDeclaredProfiles(discovered, undefined, () => {})).toHaveLength(2);
    expect(narrowDeclaredProfiles(discovered, ["none"], () => {})).toHaveLength(0);
  });

  it("polls quota only for profiles that HAVE an OAuth token to read", () => {
    // An API-key profile holds no OAuth session, so a request for it is a guaranteed waste
    // of a shared rate budget. It is still attested — it simply reports no quota.
    expect(quotaPollableProfiles(discoverLocalProfiles(fakeHome())).map((p) => p.profile)).toEqual(["oauth"]);
  });
});
