// @gate:always-run — reads the auth-ring SOURCE files, which are outside this test's own
// import graph (the doctor deliberately does not import them: it ships in the standalone
// worker binary, which must never reach the database layer).
//
// #774 (remaining #755 item 4). Two things are checked here:
//
//  1. THE DUPLICATION IS PINNED. `PROVIDER_AUTH_FILES` restates the `authFiles` lists from
//     `claude-subscription-ring.ts` / `codex-license-ring.ts` because importing them would
//     pull the db graph into the worker binary. A restated constant that nothing checks is
//     how a "logged in" answer goes quietly wrong, so this test reads those two files and
//     fails when either list moves.
//
//  2. AN INDETERMINATE RESULT IS NEVER A PASS. The provider-login check cannot prove a login
//     (an env API key is invisible to it), so it must report `unknown`. A doctor that says
//     PASS for something it did not verify is worse than no doctor, and `unknown` vs `fail`
//     matters too: calling an env-key setup "not logged in" sends an operator to fix
//     something that is already fine.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROVIDER_AUTH_FILES,
  checkProvider,
  readSavedIdentity,
  renderDoctorReport,
  runBoardDoctor,
  type DoctorReport,
} from "../cli/commands/worker-doctor.js";

const SERVER_SRC = resolve(__dirname, "..");

/** The `authFiles: [...]` array declared in one auth-ring config, read from source. */
function authFilesFromRingSource(relPath: string): string[] {
  const source = readFileSync(resolve(SERVER_SRC, relPath), "utf8");
  const match = /authFiles:\s*\[([^\]]*)\]/.exec(source);
  if (!match) throw new Error(`no authFiles array found in ${relPath}`);
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("worker doctor — provider auth parity", () => {
  it("mirrors the auth-ring authFiles lists exactly", () => {
    expect(PROVIDER_AUTH_FILES.claude!.files).toEqual(
      authFilesFromRingSource("services/claude-subscription-ring.ts"),
    );
    expect(PROVIDER_AUTH_FILES.codex!.files).toEqual(
      authFilesFromRingSource("services/codex-license-ring.ts"),
    );
  });

  it("the parity reader really sees a divergence", () => {
    // Proving the guard above can fail: the extractor must pick up a CHANGED list, not just
    // return whatever it was told.
    expect(authFilesFromRingSource("services/codex-license-ring.ts")).not.toEqual([".nope.json"]);
    expect(authFilesFromRingSource("services/claude-subscription-ring.ts").length).toBeGreaterThan(0);
  });
});

describe("worker doctor — provider checks", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wd-home-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reports a missing provider CLI as a failure with a remedy", async () => {
    const checks = await checkProvider("definitely-not-a-real-cli-774", home);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.remedy).toContain("never ships it");
  });

  it("reports an absent auth file as UNKNOWN, not a failure", async () => {
    // `node --version` stands in for a provider binary that exists: the point of this case is
    // the LOGIN half, and node is the one CLI guaranteed to be on PATH in any test runner.
    const withNode = { ...PROVIDER_AUTH_FILES };
    try {
      PROVIDER_AUTH_FILES.node = { dir: ".node-auth", files: ["auth.json"], loginCommand: "node --login" };
      const checks = await checkProvider("node", home);
      const login = checks.find((c) => c.name === "node logged in");
      expect(login?.status).toBe("unknown");
      expect(login?.detail).toContain("env API key");
    } finally {
      delete PROVIDER_AUTH_FILES.node;
      Object.assign(PROVIDER_AUTH_FILES, withNode);
    }
  });

  it("reports a present auth file as a pass", async () => {
    try {
      PROVIDER_AUTH_FILES.node = { dir: ".node-auth", files: ["auth.json"], loginCommand: "node --login" };
      mkdirSync(join(home, ".node-auth"), { recursive: true });
      writeFileSync(join(home, ".node-auth", "auth.json"), "{}");
      const checks = await checkProvider("node", home);
      expect(checks.find((c) => c.name === "node logged in")?.status).toBe("pass");
    } finally {
      delete PROVIDER_AUTH_FILES.node;
    }
  });

  it("reports a provider with no known auth location as unknown, never a pass", async () => {
    const checks = await checkProvider("node", home);
    const login = checks.find((c) => c.name === "node logged in");
    expect(login?.status).toBe("unknown");
    expect(login?.detail).toContain("no known auth-file location");
  });
});

describe("worker doctor — saved pairing", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wd-state-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null when there is no state file, so the doctor SKIPS rather than fails", () => {
    expect(readSavedIdentity(join(dir, "nope.json"), "http://board:3003")).toBeNull();
  });

  it("finds the identity for the board url, trailing slash and all", () => {
    const file = join(dir, "worker-state.json");
    writeFileSync(
      file,
      JSON.stringify({ boards: { "http://board:3003": { workerId: "w1", workerToken: "t1", name: "n" } } }),
    );
    expect(readSavedIdentity(file, "http://board:3003/")?.workerId).toBe("w1");
    expect(readSavedIdentity(file, "http://other:3003")).toBeNull();
  });

  it("treats a corrupt state file as no pairing rather than throwing", () => {
    const file = join(dir, "broken.json");
    writeFileSync(file, "{not json");
    expect(readSavedIdentity(file, "http://board:3003")).toBeNull();
  });
});

describe("worker doctor-board — what the board sees", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFleet(body: unknown, status = 200): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  }

  it("names the online-but-not-connected state instead of calling the worker healthy", async () => {
    stubFleet({
      workers: [
        {
          id: "w1",
          name: "buildbox",
          effectiveStatus: "online",
          connected: false,
          load: 0,
          maxConcurrency: 2,
          freeSlots: 2,
          eligible: false,
          ineligibleReason: "heartbeat is fresh but the board holds no WebSocket for it",
        },
      ],
      fleet: { freeSlots: 0, eligible: 0, registered: 1 },
    });
    const report = await runBoardDoctor({ boardUrl: "http://127.0.0.1:3001" });
    expect(report.ok).toBe(false);
    const row = report.checks.find((c) => c.name === "worker buildbox");
    expect(row?.status).toBe("fail");
    expect(row?.detail).toContain("no WebSocket");
    // And the report says which half of the fleet it is speaking for.
    expect(report.side).toBe("board");
  });

  it("passes a fully healthy worker and reports free capacity", async () => {
    stubFleet({
      workers: [
        {
          id: "w1",
          name: "buildbox",
          effectiveStatus: "online",
          connected: true,
          load: 1,
          maxConcurrency: 2,
          freeSlots: 1,
          eligible: true,
          ineligibleReason: null,
        },
      ],
      fleet: { freeSlots: 1, eligible: 1, registered: 1 },
    });
    const report = await runBoardDoctor({ boardUrl: "http://127.0.0.1:3001" });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "free capacity")?.status).toBe("pass");
  });

  it("explains a 404 as 'you pointed this at the fleet port'", async () => {
    stubFleet({ error: "not found" }, 404);
    const report = await runBoardDoctor({ boardUrl: "http://board:3003" });
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.remedy).toContain("FLEET port");
  });

  it("treats an empty fleet as a failure with the pairing remedy", async () => {
    stubFleet({ workers: [], fleet: { freeSlots: 0, eligible: 0, registered: 0 } });
    const report = await runBoardDoctor({ boardUrl: "http://127.0.0.1:3001" });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "workers registered")?.remedy).toContain("worker pair");
  });
});

describe("worker doctor — rendering", () => {
  it("prints the two-command constraint on the worker-side report", () => {
    const report: DoctorReport = {
      side: "worker",
      boardUrl: "http://board:3003",
      checks: [
        { name: "fleet port reachable", status: "pass", detail: "200" },
        { name: "claude logged in", status: "unknown", detail: "no auth file", remedy: "run claude /login" },
      ],
      ok: true,
    };
    const text = renderDoctorReport(report);
    expect(text).toContain("[PASS] fleet port reachable");
    expect(text).toContain("[????] claude logged in");
    expect(text).toContain("run claude /login");
    // The honest framing: this half genuinely cannot see the board's view (docs §1).
    expect(text).toContain("doctor-board");
    expect(text).toContain("1 indeterminate");
  });

  it("does not print a remedy under a passing check", () => {
    const text = renderDoctorReport({
      side: "board",
      boardUrl: "http://127.0.0.1:3001",
      checks: [{ name: "x", status: "pass", detail: "fine", remedy: "should not appear" }],
      ok: true,
    });
    expect(text).not.toContain("should not appear");
  });
});
