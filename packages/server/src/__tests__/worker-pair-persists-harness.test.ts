// #1386: pairing on a fresh machine records the harness it was set up with, so `start` resolves clean.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../worker/worker-daemon.js", async () => {
  const actual = await vi.importActual<typeof import("../worker/worker-daemon.js")>("../worker/worker-daemon.js");
  return {
    ...actual,
    registerWithBoard: vi.fn(async (_o: unknown, _b: string, name: string) => ({ workerId: "w1", name, token: "t" })),
  };
});

import { pairWorker } from "../worker/worker-pair.js";
import { createWorkerHarness, readPersistedHarness, resolveHarnessConfig } from "../worker/worker-harness.js";

let dir: string;
let stateFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ak-pair-harness-"));
  stateFile = join(dir, "worker-state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pair = (harness?: ReturnType<typeof createWorkerHarness>) =>
  pairWorker({ boardUrl: "http://board:3001", pairingToken: "p", providers: [], attestProviders: false, stateFile, harness } as never);

describe("pairWorker persists the harness (#1386)", () => {
  it("fresh state -> pair -> start resolves clean, not legacy inherit", async () => {
    await pair(createWorkerHarness({ stateFile }));
    expect(readPersistedHarness(stateFile)).toEqual({ mode: "clean" });
    const cfg = resolveHarnessConfig(stateFile);
    expect(cfg.mode).toBe("clean");
    expect(cfg.legacyInherit).toBe(false);
  });

  it("records a custom config dir", async () => {
    await pair(createWorkerHarness({ stateFile, claudeConfigDir: join(dir, "mine") }));
    const cfg = resolveHarnessConfig(stateFile);
    expect(cfg.mode).toBe("custom");
    expect(cfg.options.claudeConfigDir).toBe(join(dir, "mine"));
    expect(cfg.options.codexHome).toBeUndefined();
  });

  it("a state file whose pairing predates harness modes stays legacy inherit", async () => {
    writeFileSync(stateFile, JSON.stringify({ boards: { "http://old:3001": { workerId: "o", name: "o", token: "t" } } }));
    await pair(createWorkerHarness({ stateFile }));
    expect(readPersistedHarness(stateFile)).toBeUndefined();
    expect(resolveHarnessConfig(stateFile).legacyInherit).toBe(true);
  });
});
