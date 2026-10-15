import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createConnectFleetRoute, createConnectOwnerRoute } from "../routes/worker-connect.js";
import { createConnectCodeStore } from "../services/worker-connect-code.service.js";
import { buildConnectRunbook } from "../lib/worker-connect-runbook.js";
import type { WorkerRegistry } from "../services/worker-registry.service.js";

function setup(maxFetches = 3) {
  const store = createConnectCodeStore({ maxFetches });
  const reg = {
    mintPairingToken: () => ({ pairingToken: "tok-abc123", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
  } as unknown as WorkerRegistry;
  const app = new Hono();
  app.route("/api/workers/connect-code", createConnectOwnerRoute(reg, () => ({ fleetUrl: "http://100.1.2.3:3003", fleetNote: null }), store));
  app.route("/connect", createConnectFleetRoute(store));
  return { app, store };
}

async function mint(app: Hono, body: Record<string, unknown> = {}) {
  const res = await app.request("/api/workers/connect-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ os: "unix", ...body }),
  });
  return { res, json: (await res.json()) as Record<string, string> };
}

describe("connect code (#1442)", () => {
  it("serves the same markdown the mint response carries, with the token and start flags", async () => {
    const { app } = setup();
    const { res, json } = await mint(app, { labels: "docker", maxConcurrency: 3, profileAlias: "default=anth", toolchainInstall: "auto", toolchainAllow: "java", workerName: "desk-x" });
    expect(res.status).toBe(201);
    const page = await app.request(`/connect/${json.code}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/markdown");
    const text = await page.text();
    expect(text).toBe(json.markdown);
    expect(text).toContain("tok-abc123");
    expect(text).toContain("--max-concurrency 3");
    expect(text).toContain("--profile-alias default=anth");
    expect(text).toContain("--toolchain-install auto");
    expect(text).toContain("--toolchain-allow java");
    expect(text).toContain("instructions from the operator");
    expect(text).toContain("MSYS_NO_PATHCONV=1");
    expect(json.agentPrompt).toContain(json.agentUrl);
  });

  it("?format=json lists steps with needsHuman", async () => {
    const { app } = setup();
    const { json } = await mint(app);
    const body = (await (await app.request(`/connect/${json.code}?format=json`)).json()) as { steps: Array<{ id: string; needsHuman: boolean; humanCommand?: string; check?: string }> };
    const login = body.steps.find((s) => s.id === "login");
    expect(login?.needsHuman).toBe(true);
    expect(login?.humanCommand).toBeTruthy();
    expect(login?.check).toBeTruthy();
    expect(body.steps.some((s) => s.id === "doctor")).toBe(true);
  });

  it("returns 410 for unknown, over-fetched, revoked and paired codes", async () => {
    const { app, store } = setup(2);
    expect((await app.request("/connect/nope")).status).toBe(410);
    const a = (await mint(app)).json;
    await app.request(`/connect/${a.code}`);
    await app.request(`/connect/${a.code}`);
    const limited = await app.request(`/connect/${a.code}`);
    expect(limited.status).toBe(410);
    expect(await limited.text()).toContain("fetched too many times");

    const b = (await mint(app)).json;
    await app.request(`/api/workers/connect-code/${b.code}/revoke`, { method: "POST" });
    expect((await app.request(`/connect/${b.code}`)).status).toBe(410);

    const c = (await mint(app)).json;
    store.markPaired("tok-abc123");
    const used = await app.request(`/connect/${c.code}`);
    expect(used.status).toBe(410);
    expect(await used.text()).toContain("already used");
  });

  it("expires after the TTL", () => {
    const store = createConnectCodeStore();
    const { code } = store.mint({ pairingToken: "t", fleetUrl: "http://h:1", options: { os: "unix" }, ttlMs: 1000, nowMs: 1_000_000 });
    expect(store.consumeFetch(code, 1_000_500).ok).toBe(true);
    const late = store.consumeFetch(code, 1_002_000);
    expect(late).toEqual({ ok: false, reason: "expired" });
  });

  it("records progress, still accepted after pairing, visible to the owner", async () => {
    const { app, store } = setup();
    const { json } = await mint(app);
    store.markPaired("tok-abc123");
    const post = await app.request(`/connect/${json.code}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step: "doctor", status: "ok", output: "all green" }),
    });
    expect(post.status).toBe(200);
    const view = (await (await app.request(`/api/workers/connect-code/${json.code}`)).json()) as { status: string; progress: Array<{ step: string }> };
    expect(view.status).toBe("used");
    expect(view.progress.map((p) => p.step)).toEqual(["paired", "doctor"]);
    const bad = await app.request(`/connect/${json.code}/progress`, { method: "POST", body: "{}" });
    expect(bad.status).toBe(422);
  });

  it("rejects shell-hostile option values", async () => {
    const { app } = setup();
    expect((await mint(app, { labels: "a;rm -rf /" })).res.status).toBe(422);
    expect((await mint(app, { workerName: "x y" })).res.status).toBe(422);
    expect((await mint(app, { os: "plan9" })).res.status).toBe(422);
  });

  it("builds a Windows scheduled-task service step and a systemd one for wsl", () => {
    const base = { fleetUrl: "http://h:3003", pairingToken: "t", code: "c" };
    const win = buildConnectRunbook({ ...base, options: { os: "windows" } }).markdown;
    expect(win).toContain("Register-ScheduledTask");
    expect(win).toContain(".agentic-kanban\\bin\\agentic-kanban-worker.cmd"); // #1482: the task runs the stable shim
    const wsl = buildConnectRunbook({ ...base, options: { os: "wsl" } }).markdown;
    expect(wsl).toContain("systemctl --user enable --now");
    expect(wsl).toContain("Dev Drive");
  });
});
