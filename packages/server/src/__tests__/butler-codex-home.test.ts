import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { projects } from "@agentic-kanban/shared/schema";

/**
 * #829 — A codex butler running under an OAuth license must launch under that
 * license's CODEX_HOME directory (its own auth.json + rollouts) with `--profile`
 * dropped, mirroring the builder path in session-lifecycle.ts. Otherwise the butler
 * authenticates under the DEFAULT ~/.codex account and its rollouts land in the wrong
 * home — a root cause of the "no rollout found" resume failures.
 *
 * This test mocks node:child_process.spawn to capture the launch env + args, then
 * drives a real codex butler turn through the route → resolveButlerBackend →
 * ensureButlerSession → spawn pipeline.
 */

const spawnMock = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[]; env: Record<string, string | undefined> }>,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn((command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
    spawnMock.calls.push({ command, args, env: options?.env ?? {} });
    const handlers = {
      stdout: [] as Array<(b: Buffer) => void>,
      stderr: [] as Array<(b: Buffer) => void>,
      exit: [] as Array<(code: number) => void>,
    };
    const drive = () => setTimeout(() => {
      for (const cb of handlers.stdout) {
        cb(Buffer.from(`${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n`));
        cb(Buffer.from(`${JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "ok" } })}\n`));
        cb(Buffer.from(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`));
      }
      for (const cb of handlers.exit) cb(0);
    }, 0);
    return {
      pid: 2000 + spawnMock.calls.length,
      stdout: { on: (ev: string, cb: (b: Buffer) => void) => { if (ev === "data") handlers.stdout.push(cb); } },
      stderr: { on: (ev: string, cb: (b: Buffer) => void) => { if (ev === "data") handlers.stderr.push(cb); } },
      stdin: { end: () => drive(), write: () => {} },
      on: (ev: string, cb: (...a: unknown[]) => void) => { if (ev === "exit") handlers.exit.push(cb as (code: number) => void); },
      kill: () => {},
    };
  }),
}));

import { createButlerRoute } from "../routes/butler.js";
import { setPreference } from "../repositories/preferences.repository.js";
import { stopButlerSession } from "../services/butler-sdk.service.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/projects", createButlerRoute(db, () => createMockSessionManager()));
  });
}

async function createProject(db: TestDb): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(projects).values({
    id, name: "Codex Home Test", repoPath: process.cwd(), repoName: "agentic-kanban",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  return id;
}

function waitFor(desc: string, cond: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error(`Timed out waiting for ${desc}`));
      setTimeout(check, 5);
    };
    check();
  });
}

describe("Codex butler CODEX_HOME for license profiles (#829)", () => {
  const toStop: string[] = [];

  beforeEach(() => { spawnMock.calls.length = 0; });
  afterEach(() => { while (toStop.length) stopButlerSession(toStop.pop()!); });

  it("launches a license-profile butler under its CODEX_HOME and drops --profile", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    toStop.push(projectId);
    const licenseHome = join(process.cwd(), ".codex-ki-test");
    await setPreference("provider", "codex", db);
    await setPreference("codex_profile", "ki-test", db);
    await setPreference("codex_license_ring", JSON.stringify([{ profile: "ki-test", codexHome: licenseHome }]), db);

    // The UI dropdown still shows the real license name, not "default".
    const profilesRes = await app.request(`/api/projects/${projectId}/butler/profiles`);
    expect((await profilesRes.json() as { selected: string }).selected).toBe("ki-test");

    await app.request(`/api/projects/${projectId}/butler/ensure`, { method: "POST", body: "{}" });
    await app.request(`/api/projects/${projectId}/butler/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    await waitFor("a codex spawn", () => spawnMock.calls.length >= 1);
    const call = spawnMock.calls[0];
    // CODEX_HOME points the spawn at the license dir.
    expect(call.env.CODEX_HOME).toBe(licenseHome);
    // --profile is suppressed (a separate home has no [profiles.<name>] → codex exit 2).
    expect(call.args).not.toContain("--profile");
  });

  it("does NOT override CODEX_HOME for a codex butler on the default profile", async () => {
    const { app, db } = createTestApp();
    const projectId = await createProject(db);
    toStop.push(projectId);
    await setPreference("provider", "codex", db);
    await setPreference("codex_profile", "default", db);

    await app.request(`/api/projects/${projectId}/butler/ensure`, { method: "POST", body: "{}" });
    await app.request(`/api/projects/${projectId}/butler/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    await waitFor("a codex spawn", () => spawnMock.calls.length >= 1);
    const call = spawnMock.calls[0];
    // No license dir resolved → CODEX_HOME falls through to the inherited process env.
    expect(call.env.CODEX_HOME).toBe(process.env.CODEX_HOME);
  });
});
