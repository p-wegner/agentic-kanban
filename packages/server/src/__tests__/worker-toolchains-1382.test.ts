// #1382: toolchain detection parsing, requirement matching, and placement + explain routing on them.
import { describe, it, expect, beforeEach } from "vitest";
import { preferences } from "@agentic-kanban/shared/schema";
import {
  formatWorkerToolchains,
  missingToolchains,
  parseRequiredToolchains,
  parseToolVersion,
  parseWorkerToolchains,
  suggestToolchains,
} from "@agentic-kanban/shared/lib/worker-toolchains";
import { parseWorkerCapabilities } from "@agentic-kanban/shared/lib/worker-protocol";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import type { WSContext } from "hono/ws";
import { __resetWorkerSlotReservations } from "../services/worker-slot-reservation.service.js";
import {
  getWorkerFleet,
  readPlacementRequirements,
  requiredToolchainsPrefKey,
  resolveWorkerPlacement,
  selectWorkerForLaunch,
  workerDispatchPrefKey,
  workerStrictPrefKey,
  SHARES_FILESYSTEM_LABEL,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";
import { describeFleet, explainPlacement } from "../services/placement-explain.service.js";
import { detectToolchains, refreshToolchains, resetToolchainCache, toolchainsField } from "../cli/commands/worker-doctor-git-prereqs.js";

const PROJECT_ID = "bbbb1111-2222-3333-4444-555566667777";

describe("toolchain parsing and matching (#1382)", () => {
  it("parses version output of the probed tools", () => {
    expect(parseToolVersion('openjdk version "21.0.4" 2024-07-16')).toBe("21.0.4");
    expect(parseToolVersion('java version "1.8.0_392"')).toBe("8.0");
    expect(parseToolVersion("v22.1.0")).toBe("22.1.0");
    expect(parseToolVersion("go version go1.22.3 windows/amd64")).toBe("1.22.3");
    expect(parseToolVersion("Python 3.12.1")).toBe("3.12.1");
    expect(parseToolVersion("no digits here")).toBe("");
  });

  it("parses `pnpm, java>=21`, drops junk, keeps the stricter duplicate", () => {
    expect(parseRequiredToolchains("pnpm, java>=21")).toEqual([{ name: "pnpm" }, { name: "java", minVersion: "21" }]);
    expect(parseRequiredToolchains("java>=17, java>=21, ???, ")).toEqual([{ name: "java", minVersion: "21" }]);
    expect(parseRequiredToolchains(undefined)).toEqual([]);
  });

  it("matches versions numerically and treats a silent worker as unknown", () => {
    const need = parseRequiredToolchains("java>=21, pnpm");
    expect(missingToolchains(need, { java: "21.0.4", pnpm: "9.1.0" })).toEqual([]);
    expect(missingToolchains(need, { java: "17.0.9", pnpm: "9.1.0" })).toEqual(["java>=21"]);
    expect(missingToolchains(need, { java: "9", pnpm: "1" })).toEqual(["java>=21"]); // 9 < 21, not string order
    expect(missingToolchains(need, { node: "22" })).toEqual(["java>=21", "pnpm"]);
    expect(missingToolchains(need, { java: "", pnpm: "" })).toEqual(["java>=21"]); // present, version unknown
    expect(missingToolchains(need, undefined)).toEqual([]);
  });

  it("round-trips through the capabilities parser, dropping unknown names and bad values", () => {
    const caps = parseWorkerCapabilities({ toolchains: { java: "21.0.4", bogus: "1", node: 22 } });
    expect(caps?.toolchains).toEqual({ java: "21.0.4" });
    expect(parseWorkerToolchains("nope")).toBeUndefined();
    expect(formatWorkerToolchains({ node: "22.1.0", docker: "" })).toBe("node 22.1.0, docker");
  });

  it("suggests toolchains from repo files", () => {
    expect(suggestToolchains(["package.json", "pnpm-lock.yaml", "gradlew"])).toEqual([{ name: "pnpm" }, { name: "java" }]);
    expect(suggestToolchains(["go.mod"], { goMod: "module x\n\ngo 1.22.3\n" })).toEqual([{ name: "go", minVersion: "1.22.3" }]);
    expect(suggestToolchains(["pyproject.toml", "uv.lock"])).toEqual([{ name: "uv" }]);
    expect(suggestToolchains([])).toEqual([]);
  });
});

describe("worker-side detection (#1382)", () => {
  it("reports only the tools that ran, with parsed versions", async () => {
    const found = await detectToolchains(async (cmd) =>
      cmd === "java" ? 'openjdk version "21.0.4"' : cmd === "node" ? "v22.1.0" : null,
    );
    expect(found).toEqual({ node: "22.1.0", java: "21.0.4" });
  });

  it("caches, and spreads nothing before the first reading", async () => {
    resetToolchainCache();
    await refreshToolchains(1_000_000, async (cmd) => (cmd === "go" ? "go version go1.22.3 linux/amd64" : null));
    expect(toolchainsField(1_000_001)).toEqual({ toolchains: { go: "1.22.3" } });
    resetToolchainCache();
  });
});

describe("placement routes on required toolchains (#1382)", () => {
  let db: Database;
  let fleet: WorkerFleet;
  const ws = () => ({ send: () => {}, close: () => {} }) as unknown as WSContext;

  beforeEach(() => {
    __resetWorkerSlotReservations();
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
  });

  async function pref(key: string, value: string) {
    await db.insert(preferences).values({ key, value });
  }

  async function addWorker(name: string, toolchains?: Record<string, string>) {
    const { pairingToken } = fleet.registry.mintPairingToken();
    const res = await fleet.registry.registerWorker({
      pairingToken, name, providers: ["claude"], labels: [SHARES_FILESYSTEM_LABEL], protocolVersion: 1,
    });
    if (!res.ok) throw new Error(res.error);
    fleet.connections.handleOpen(res.workerId, ws());
    fleet.registry.noteToolchains(res.workerId, toolchains);
    return res.workerId;
  }

  it("never places java>=21 work on a worker without java, and says why", async () => {
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(workerStrictPrefKey(PROJECT_ID), "true");
    await pref(requiredToolchainsPrefKey(PROJECT_ID), "java>=21");
    await addWorker("desktop-stable", { node: "22.1.0", pnpm: "9.1.0" });
    await addWorker("old-jdk", { java: "17.0.9" });
    const requirements = await readPlacementRequirements(PROJECT_ID, db);
    expect(await selectWorkerForLaunch(fleet, "claude", requirements)).toBeNull();

    const snapshot = await describeFleet({ database: db, projectId: PROJECT_ID });
    const byName = Object.fromEntries(snapshot.workers.map((w) => [w.name, w]));
    expect(byName["desktop-stable"]!.eligible).toBe(false);
    expect(byName["desktop-stable"]!.ineligibleReason).toContain("lacks java>=21");
    expect(byName["old-jdk"]!.ineligibleReason).toContain("lacks java>=21");
    expect(byName["desktop-stable"]!.toolchains).toEqual({ node: "22.1.0", pnpm: "9.1.0" });

    const explained = await explainPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    const check = explained.chain.find((c) => c.id === "eligible_worker")!;
    expect(check.outcome).toBe("decided");
    expect(check.detail).toContain("desktop-stable");
    expect(check.detail).toContain("lacks java>=21");
    expect(check.prefKeys).toContain(requiredToolchainsPrefKey(PROJECT_ID));

    // A worker that does have it is picked.
    const good = await addWorker("jvm-box", { java: "21.0.4" });
    expect(await selectWorkerForLaunch(fleet, "claude", requirements)).toBe(good);
    const placement = await resolveWorkerPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(placement.kind).toBe("remote");
    expect(placement.kind === "remote" && placement.workerId).toBe(good);
  });

  it("routes a pnpm-only project to workers reporting pnpm; a silent (older) worker stays unknown, not excluded", async () => {
    await pref(requiredToolchainsPrefKey(PROJECT_ID), "pnpm");
    await addWorker("no-pnpm", { node: "22.1.0" });
    const requirements = await readPlacementRequirements(PROJECT_ID, db);
    expect(await selectWorkerForLaunch(fleet, "claude", requirements)).toBeNull();
    const silent = await addWorker("older-build");
    expect(await selectWorkerForLaunch(fleet, "claude", requirements)).toBe(silent);
    const withPnpm = await addWorker("pnpm-box", { pnpm: "9.1.0" });
    const snapshot = await describeFleet({ database: db, projectId: PROJECT_ID });
    expect(snapshot.workers.find((w) => w.workerId === withPnpm)!.eligible).toBe(true);
    expect(snapshot.workers.find((w) => w.name === "no-pnpm")!.ineligibleReason).toContain("lacks pnpm");
  });

  it("a project with no requirement is unaffected", async () => {
    const w = await addWorker("bare", { node: "22.1.0" });
    expect(await readPlacementRequirements(PROJECT_ID, db)).toEqual([]);
    expect(await selectWorkerForLaunch(fleet, "claude", [])).toBe(w);
  });
});
