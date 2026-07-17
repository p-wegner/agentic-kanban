import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { composeProjectName } from "@agentic-kanban/shared";
import { projects, projectStatuses, issues, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  buildKnownComposeProjectNames,
  reapOrphanServiceStacksOnce,
} from "../startup/service-stack-reaper.js";

const INSTANCE = "inst0001";

describe("buildKnownComposeProjectNames (#52 status-aware known set)", () => {
  const wsUp = "wsupwsupwsup";
  const wsErr = "wserrwserrer";
  const wsNull = "wsnullwsnull";
  const upState = JSON.stringify({ composeProjectName: "ak-x-ws-live", ports: {}, status: "up" });
  const errState = JSON.stringify({ composeProjectName: composeProjectName(wsErr, INSTANCE), ports: {}, status: "error" });
  const downState = JSON.stringify({ composeProjectName: composeProjectName(wsErr, INSTANCE), ports: {}, status: "down" });

  it("shields a live 'up' stack by its STORED compose name", () => {
    const known = buildKnownComposeProjectNames([{ workspaceId: wsUp, serviceState: upState }], INSTANCE, { shieldMidProvision: true });
    expect([...known]).toEqual(["ak-x-ws-live"]);
  });

  it("does NOT shield an open 'error' or 'down' stack (Half 2 — open failed row is reapable)", () => {
    for (const state of [errState, downState]) {
      const known = buildKnownComposeProjectNames([{ workspaceId: wsErr, serviceState: state }], INSTANCE, { shieldMidProvision: true });
      expect(known.size).toBe(0);
    }
  });

  it("periodic (shieldMidProvision) shields a null-state row's DETERMINISTIC name — protects an in-flight create", () => {
    const known = buildKnownComposeProjectNames([{ workspaceId: wsNull, serviceState: null }], INSTANCE, { shieldMidProvision: true });
    expect([...known]).toEqual([composeProjectName(wsNull, INSTANCE)]);
  });

  it("boot (no shieldMidProvision) leaves a null-state row REAPABLE — crash-mid-up orphan", () => {
    const known = buildKnownComposeProjectNames([{ workspaceId: wsNull, serviceState: null }], INSTANCE, { shieldMidProvision: false });
    expect(known.size).toBe(0);
  });

  it("an unusable instance id never throws — the null-state row simply contributes nothing", () => {
    const known = buildKnownComposeProjectNames([{ workspaceId: wsNull, serviceState: null }], "", { shieldMidProvision: true });
    expect(known.size).toBe(0);
  });
});

describe("reapOrphanServiceStacksOnce", () => {
  let db: TestDb;

  async function seedWorkspace(status: string, serviceState: string | null, servicesEnabled = false): Promise<string> {
    const now = new Date(Date.now() - 60_000).toISOString();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const statusId = randomUUID();
    const workspaceId = randomUUID();
    const servicesConfig = servicesEnabled ? JSON.stringify({ enabled: true }) : null;
    await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p", defaultBranch: "main", servicesConfig, createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now });
    await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "T", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
    await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/x", status, serviceState, createdAt: now, updatedAt: now });
    return workspaceId;
  }

  /** A fake reap that downs every listed daemon stack NOT in the known set. */
  function fakeReapOver(daemonStacks: string[]) {
    let capturedKnown: Set<string> | null = null;
    const reap = async ({ knownComposeProjectNames }: { knownComposeProjectNames: Set<string> }) => {
      capturedKnown = knownComposeProjectNames;
      return { reaped: daemonStacks.filter((s) => !knownComposeProjectNames.has(s)) };
    };
    return { reap, getKnown: () => capturedKnown };
  }

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("periodic pass reaps an open 'error' workspace's leaked stack but SHIELDS an in-flight (null-state) create", async () => {
    const errWs = randomUUID();
    // Deterministic names computed the same way provisioning would.
    const errStack = composeProjectName(errWs, INSTANCE);
    const errWsId = await seedWorkspace("error", JSON.stringify({ composeProjectName: errStack, ports: {}, status: "error" }));
    const inflightWs = await seedWorkspace("active", null); // create still inside `up --wait`
    const inflightStack = composeProjectName(inflightWs, INSTANCE);

    const { reap, getKnown } = fakeReapOver([errStack, inflightStack]);
    const { reaped } = await reapOrphanServiceStacksOnce({
      database: db,
      reap,
      resolveInstanceId: async () => INSTANCE,
      isDockerAvailable: async () => true,
      shieldMidProvision: true,
      logLabel: "test",
    });

    // The error stack (open, failed) is reaped; the in-flight create's deterministic
    // name is shielded so it is NOT reaped. (errWsId referenced to satisfy lint.)
    expect(errWsId).toBeTruthy();
    expect(reaped).toEqual([errStack]);
    expect(getKnown()?.has(inflightStack)).toBe(true);
    expect(getKnown()?.has(errStack)).toBe(false);
  });

  it("boot pass (no shieldMidProvision) reaps a crash-mid-up null-state stack too", async () => {
    const crashWs = await seedWorkspace("active", null, /* servicesEnabled */ true);
    const crashStack = composeProjectName(crashWs, INSTANCE);
    const { reap } = fakeReapOver([crashStack]);
    const { reaped } = await reapOrphanServiceStacksOnce({
      database: db,
      reap,
      resolveInstanceId: async () => INSTANCE,
      isDockerAvailable: async () => true,
      shieldMidProvision: false,
      logLabel: "test",
    });
    expect(reaped).toEqual([crashStack]);
  });

  it("skips the docker probe entirely when no open row has a stack and no project enables services", async () => {
    await seedWorkspace("active", null); // project seeded WITHOUT servicesConfig
    let dockerProbed = false;
    const { reaped } = await reapOrphanServiceStacksOnce({
      database: db,
      reap: async () => ({ reaped: ["should-not-run"] }),
      resolveInstanceId: async () => INSTANCE,
      isDockerAvailable: async () => {
        dockerProbed = true;
        return true;
      },
      shieldMidProvision: true,
      logLabel: "test",
    });
    expect(dockerProbed).toBe(false);
    expect(reaped).toEqual([]);
  });

  it("reaps nothing when the instance id cannot be resolved (identity before destruction)", async () => {
    const ws = await seedWorkspace("active", JSON.stringify({ composeProjectName: "ak-x-ws-e", ports: {}, status: "error" }));
    expect(ws).toBeTruthy();
    let reapCalled = false;
    const { reaped } = await reapOrphanServiceStacksOnce({
      database: db,
      reap: async () => {
        reapCalled = true;
        return { reaped: ["nope"] };
      },
      resolveInstanceId: async () => {
        throw new Error("db unavailable");
      },
      isDockerAvailable: async () => true,
      shieldMidProvision: true,
      logLabel: "test",
    });
    expect(reapCalled).toBe(false);
    expect(reaped).toEqual([]);
  });

  it("a terminal (closed) workspace does NOT shield its stale 'up' stack — the orphan is reaped", async () => {
    // A live 'up' workspace keeps the probe running (pre-check passes) and shields its
    // own stack; a CLOSED workspace whose stale blob still says 'up' is excluded from
    // the open-row query, so its compose name is NOT in the known set and gets reaped.
    const liveWs = await seedWorkspace("active", JSON.stringify({ composeProjectName: "ak-x-ws-live", ports: {}, status: "up" }));
    const closedWs = await seedWorkspace("closed", JSON.stringify({ composeProjectName: "ak-x-ws-closed", ports: {}, status: "up" }));
    expect(liveWs && closedWs).toBeTruthy();
    const { reap, getKnown } = fakeReapOver(["ak-x-ws-live", "ak-x-ws-closed"]);
    const { reaped } = await reapOrphanServiceStacksOnce({
      database: db,
      reap,
      resolveInstanceId: async () => INSTANCE,
      isDockerAvailable: async () => true,
      shieldMidProvision: true,
      logLabel: "test",
    });
    expect(getKnown()?.has("ak-x-ws-live")).toBe(true);
    expect(getKnown()?.has("ak-x-ws-closed")).toBe(false);
    expect(reaped).toEqual(["ak-x-ws-closed"]);
  });
});
