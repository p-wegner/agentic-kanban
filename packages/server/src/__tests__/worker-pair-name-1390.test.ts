// #1390: `setup`/`pair` names the worker with defaultWorkerName() (distro-aware under WSL), not the bare hostname.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registerWithBoard = vi.hoisted(() => vi.fn());
vi.mock("../worker/worker-daemon.js", async () => {
  const actual = await vi.importActual<typeof import("../worker/worker-daemon.js")>("../worker/worker-daemon.js");
  return { ...actual, registerWithBoard };
});
vi.mock("../worker/worker-name.js", () => ({ defaultWorkerName: () => "HOST-wsl-akw-r2" }));

import { pairWorker } from "../worker/worker-pair.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ak-pair-name-"));
  registerWithBoard.mockImplementation(async (_o: unknown, _b: string, name: string) => ({ workerId: "w1", name, workerToken: "t" }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const opts = { boardUrl: "http://board:3001", pairingToken: "p", providers: [], attestProviders: false } as never;

describe("pairWorker default name (#1390)", () => {
  it("uses the distro-aware default name", async () => {
    const res = await pairWorker({ ...(opts as object), stateFile: join(dir, "s.json") } as never);
    expect(res.name).toBe("HOST-wsl-akw-r2");
  });

  it("an explicit --name still wins", async () => {
    const res = await pairWorker({ ...(opts as object), name: "mine", stateFile: join(dir, "s2.json") } as never);
    expect(res.name).toBe("mine");
  });
});
