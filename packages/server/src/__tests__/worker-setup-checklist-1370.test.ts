// #1370 — the Connect tab shows the SAME node-only bootstrap `worker pair` prints, and the worker's
// doctor summary round-trips register -> GET /api/workers -> (kept across a beat that omits it).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  BOOTSTRAP_TOKEN_PLACEHOLDER,
  buildWorkerBootstrap,
  renderBootstrapText,
} from "@agentic-kanban/shared/lib/worker-bootstrap-steps";
import {
  WORKER_PROTOCOL_VERSION,
  doctorSignature,
  parseWorkerCapabilities,
  parseWorkerDoctorSummary,
  summarizeDoctorChecks,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { createWorkersRoute, createFleetWorkersRoute } from "../routes/workers.js";
import { getWorkerFleet } from "../services/worker-fleet.service.js";
import { renderBootstrapSteps } from "../cli/commands/worker-setup-guide.js";
import { buildWorkerConnectSteps } from "../lib/worker-connect-steps.js";

describe("bootstrap steps: one renderer (#1370)", () => {
  const FLEET = "http://100.1.2.3:3002";

  it("worker pair's text IS the shared renderer's text, for both OSes", () => {
    for (const os of ["windows", "unix"] as const) {
      expect(renderBootstrapSteps(FLEET, "TOK", os)).toBe(renderBootstrapText(buildWorkerBootstrap(FLEET, "TOK", os)));
    }
  });

  it("windows uses curl.exe, linux/macOS uses curl and carries the user-prefix note", () => {
    const win = renderBootstrapSteps(FLEET, "TOK", "windows");
    const unix = renderBootstrapSteps(FLEET, "TOK", "unix");
    expect(win).toContain("curl.exe");
    expect(unix).not.toContain("curl.exe");
    expect(unix).toContain('curl -fsS -H "Authorization: Bearer TOK"');
    expect(unix).toContain("EACCES");
    expect(win).not.toContain("EACCES");
    expect(unix).toContain(`setup --board ${FLEET} --token TOK`);
  });

  it("the default path has no pack-worker instructions; they sit under 'from a repo checkout'", () => {
    const steps = buildWorkerConnectSteps(FLEET, "TOK");
    const withPack = steps.filter((s) => [s.detail, ...s.commands].join("\n").includes("pack-worker"));
    expect(withPack.map((s) => s.id)).toEqual(["repo-checkout"]);
    expect(renderBootstrapSteps(FLEET, "TOK")).not.toContain("pack-worker");
  });

  it("GET /connect-info serves the bootstrap; filling the placeholders reproduces the CLI output", async () => {
    const { db } = createTestDb();
    const database = db as unknown as Database;
    const fleet = getWorkerFleet(database);
    const app = new Hono();
    app.route("/api/workers", createWorkersRoute(database, fleet.registry));
    const res = await app.request("/api/workers/connect-info");
    const info = (await res.json()) as {
      boardUrl: string;
      bootstrap: Record<"windows" | "unix", { steps: Array<{ commands: string[] }> }>;
    };
    for (const os of ["windows", "unix"] as const) {
      const fill = (line: string) =>
        line.split(BOOTSTRAP_TOKEN_PLACEHOLDER).join("MINTED").split(info.boardUrl).join(FLEET);
      const served = info.bootstrap[os].steps.flatMap((s) => s.commands.map(fill));
      const cli = buildWorkerBootstrap(FLEET, "MINTED", os).steps.flatMap((s) => s.commands);
      expect(served).toEqual(cli);
    }
  });
});

describe("doctor summary round-trip (#1370)", () => {
  let database: Database;
  let app: Hono;
  let fleetApp: Hono;
  let registry: ReturnType<typeof getWorkerFleet>["registry"];

  beforeEach(() => {
    database = createTestDb().db as unknown as Database;
    registry = getWorkerFleet(database).registry;
    app = new Hono();
    app.route("/api/workers", createWorkersRoute(database, registry));
    fleetApp = new Hono();
    fleetApp.route("/api/workers", createFleetWorkersRoute(database, registry));
  });
  afterEach(() => undefined);

  const summary = summarizeDoctorChecks(
    [
      { name: "git installed", status: "pass", detail: "git version 2.45" },
      { name: "claude CLI installed", status: "pass", detail: "1.0.0" },
      {
        name: "claude logged in",
        status: "unknown",
        detail: "none of .credentials.json found in C:/x\nsecond line",
        remedy: "agentic-kanban-worker auth claude\nmore",
      },
    ],
    { providers: ["claude"], harnessMode: "clean", now: "2026-10-11T10:00:00.000Z" },
  );

  async function listed() {
    const res = await app.request("/api/workers");
    return ((await res.json()) as { workers: Array<{ id: string; doctor?: typeof summary }> }).workers;
  }

  it("summarises to one line per field and reads the provider credential state", () => {
    expect(summary.checks[2]).toEqual({
      id: "claude logged in",
      status: "unknown",
      message: "none of .credentials.json found in C:/x",
      fix: "agentic-kanban-worker auth claude",
    });
    expect(summary.providers).toEqual([{ provider: "claude", credential: "missing" }]);
    expect(summary.harnessMode).toBe("clean");
  });

  it("never lets a token-shaped string leave the machine", () => {
    const s = summarizeDoctorChecks([
      { name: "heartbeat", status: "fail", detail: `rejected Bearer abc123SECRET and sk-ant-api03-abcdefghijkl`, remedy: "x" },
    ]);
    expect(s.checks[0]!.message).not.toContain("abc123SECRET");
    expect(s.checks[0]!.message).not.toContain("sk-ant-api03");
  });

  it("is stored on register, returned by GET /api/workers, and survives a heartbeat that omits it", async () => {
    const { pairingToken } = registry.mintPairingToken();
    const reg = await fleetApp.request("/api/workers/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingToken, name: "w1", protocolVersion: WORKER_PROTOCOL_VERSION, doctor: summary }),
    });
    expect(reg.status).toBe(201);
    const { workerId, workerToken } = (await reg.json()) as { workerId: string; workerToken: string };

    expect((await listed())[0]!.doctor).toEqual(summary);

    // A beat WITHOUT the summary means "unchanged" — it must not clear it.
    const beat = await fleetApp.request(`/api/workers/${workerId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${workerToken}` },
      body: JSON.stringify({ capabilities: { providers: ["claude"] }, protocolVersion: WORKER_PROTOCOL_VERSION }),
    });
    expect(beat.status).toBe(200);
    expect((await listed())[0]!.doctor).toEqual(summary);

    // A beat WITH a changed summary replaces it.
    const changed = summarizeDoctorChecks([{ name: "git installed", status: "fail", detail: "missing", remedy: "install git" }]);
    await fleetApp.request(`/api/workers/${workerId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${workerToken}` },
      body: JSON.stringify({ capabilities: { doctor: changed }, protocolVersion: WORKER_PROTOCOL_VERSION }),
    });
    const after = (await listed())[0]!.doctor!;
    expect(after.checks).toEqual(changed.checks);
  });

  it("parses defensively and signs summaries independent of their timestamp", () => {
    expect(parseWorkerDoctorSummary({ checks: "nope" })).toBeUndefined();
    const parsed = parseWorkerDoctorSummary({ checks: [{ id: "a", status: "weird", message: 5 }, { nope: 1 }] });
    expect(parsed?.checks).toEqual([{ id: "a", status: "unknown", message: "" }]);
    expect(parseWorkerCapabilities({ doctor: summary })?.doctor?.checks).toHaveLength(3);
    expect(doctorSignature(summary)).toBe(doctorSignature({ ...summary, checkedAt: "2030-01-01T00:00:00.000Z" }));
    expect(doctorSignature(summary)).not.toBe(doctorSignature({ ...summary, checks: summary.checks.slice(1) }));
  });
});
