// @covers agent-sessions.resume.provider-id [workflow,regression]
//
// The provider resume-token round-trip that underpins every multi-turn / relaunch flow:
//   CAPTURE — a provider init/session-header stream event (Claude `system/init` session_id,
//             Pi `{"type":"session","id":...}` header) flows through the REAL parse + broadcast
//             path and the captured id is PERSISTED to the session row (sessions.providerSessionId).
//   RESUME  — on relaunch, the stored providerSessionId is looked up and forwarded to the agent
//             launcher, where it becomes `--resume <id>` in the spawned agent args.
//
// Why this is the gap: `apply-stream-event.test.ts` mocks the DB so the persistence path is never
// exercised (it characterizes the synchronous state mutations only), and the lifecycle tests never
// drive a resume. The per-provider flag CONSTRUCTION is covered in `agent-provider.test.ts`; what
// was UNCOVERED is the end-to-end chain — parse → persist (real DB row) and stored-id → relaunch
// forward → `--resume`. A silent break here strands a resume into a fresh session and loses context.
//
// Mutation check:
//   * CAPTURE goes RED if `applyStreamEvent` stops calling `updateProviderSessionId` (the parsed id
//     never lands on the row → the poll times out and the `providerSessionId` assertion fails).
//   * RESUME goes RED if relaunch stops consulting the previous session / forwarding the stored id
//     (the launcher receives `undefined` at the resume slot → no `--resume <id>` in the agent args).

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, sessions } from "@agentic-kanban/shared/schema";

// Route the broadcast persistence path (module-level `writeDb`) at a REAL in-memory test DB so we
// assert the captured id actually lands in the sessions row — not a structural mock spy. The async
// mock factory builds the DB and stashes it on a hoisted holder readable from the test body.
const h = vi.hoisted(() => ({ db: undefined as unknown as import("./helpers/test-db.js").TestDb }));
vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const { db } = createTestDb();
  h.db = db;
  return { db, writeDb: db };
});

vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

// Import the real units AFTER the db mock is registered.
const { createBroadcaster } = await import("../services/session-manager/broadcast.js");
const { createSessionState } = await import("../services/session-manager/types.js");
const { createSessionLifecycle } = await import("../services/session-manager/session-lifecycle.js");
const { buildAgentLaunchConfig } = await import("../services/agent-provider.js");
const { createMockProc } = await import("./helpers/mocks.js");
import type { AgentService } from "../services/session-manager/session-lifecycle.js";
import type { TestDb } from "./helpers/test-db.js";
import type { workspaceLaunchPreflight } from "../services/preflight-check.js";

type Seeded = { workspaceId: string };

/** Seed project + status + issue + an active claude worktree workspace into the given db. */
async function seedWorkspace(db: TestDb): Promise<Seeded> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const statusId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "T", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1", workingDir: "/tmp/repo/.worktrees/ak-1",
    baseBranch: "main", isDirect: false, status: "active", provider: "claude",
    createdAt: now, updatedAt: now,
  });
  return { workspaceId };
}

/** Insert a session row (so the providerSessionId UPDATE has a row to land on). */
async function insertSessionRow(
  db: TestDb,
  workspaceId: string,
  fields: { id: string; executor?: string; status?: string; providerSessionId?: string | null },
): Promise<string> {
  const now = new Date().toISOString();
  await db.insert(sessions).values({
    id: fields.id,
    workspaceId,
    executor: fields.executor ?? "claude-code",
    status: fields.status ?? "running",
    startedAt: now,
    providerSessionId: fields.providerSessionId ?? null,
  });
  return fields.id;
}

function okPreflight(): typeof workspaceLaunchPreflight {
  return vi.fn(async () => ({ ok: true, errors: [], staleFiles: [], refreshed: false, dirtyFiles: [] })) as unknown as typeof workspaceLaunchPreflight;
}

/** Poll a condition until true or the deadline lapses (settles fire-and-forget DB writes). */
async function poll(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function readProviderSessionId(db: TestDb, sessionId: string): Promise<string | null | undefined> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  return rows[0]?.providerSessionId;
}

describe("agent-sessions.resume.provider-id — capture + relaunch", () => {
  describe("CAPTURE: provider init event persists providerSessionId to the session row", () => {
    it("persists Claude's system/init session_id from the real broadcast path", async () => {
      const { workspaceId } = await seedWorkspace(h.db);
      const sessionId = await insertSessionRow(h.db, workspaceId, { id: randomUUID() });

      const state = createSessionState();
      state.sessionProviders.set(sessionId, "claude");
      const broadcast = createBroadcaster(state, undefined);

      const resumeToken = "claude-init-" + randomUUID();
      // A real Claude stream-json system/init line (the event that carries the resume token).
      broadcast(sessionId, {
        type: "stdout",
        data: JSON.stringify({ type: "system", subtype: "init", session_id: resumeToken, model: "claude-opus-4-8", cwd: "/tmp/repo" }),
      });

      const landed = await poll(async () => (await readProviderSessionId(h.db, sessionId)) === resumeToken);
      expect(landed).toBe(true);
      expect(await readProviderSessionId(h.db, sessionId)).toBe(resumeToken);
    });

    it("persists Pi's JSONL session-header id from the real broadcast path", async () => {
      const { workspaceId } = await seedWorkspace(h.db);
      const sessionId = await insertSessionRow(h.db, workspaceId, { id: randomUUID(), executor: "pi" });

      const state = createSessionState();
      state.sessionProviders.set(sessionId, "pi");
      const broadcast = createBroadcaster(state, undefined);

      const resumeToken = "pi-session-" + randomUUID();
      broadcast(sessionId, {
        type: "stdout",
        data: JSON.stringify({ type: "session", version: 3, id: resumeToken, cwd: "/tmp/repo/.worktrees/ak-1" }),
      });

      const landed = await poll(async () => (await readProviderSessionId(h.db, sessionId)) === resumeToken);
      expect(landed).toBe(true);
      expect(await readProviderSessionId(h.db, sessionId)).toBe(resumeToken);
    });

    it("leaves providerSessionId null for a stream that carries no init/session header", async () => {
      const { workspaceId } = await seedWorkspace(h.db);
      const sessionId = await insertSessionRow(h.db, workspaceId, { id: randomUUID() });

      const state = createSessionState();
      state.sessionProviders.set(sessionId, "claude");
      const broadcast = createBroadcaster(state, undefined);

      // Assistant text only — no session_id anywhere in the stream.
      broadcast(sessionId, {
        type: "stdout",
        data: JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", content: [{ type: "text", text: "working" }] } }),
      });

      // Give any (incorrect) write a chance to land, then assert it stayed null.
      await new Promise((r) => setTimeout(r, 100));
      expect(await readProviderSessionId(h.db, sessionId)).toBeNull();
    });
  });

  describe("RESUME: a relaunch forwards the stored providerSessionId as --resume <id>", () => {
    it("looks up the previous session's providerSessionId and spawns the agent with --resume <id>", async () => {
      // Isolated DB for the lifecycle half (injected; independent of the broadcast-path DB).
      const { createTestDb } = await import("./helpers/test-db.js");
      const { db } = createTestDb();
      const { workspaceId } = await seedWorkspace(db);

      // A prior, completed Claude session that captured a resume token (the CAPTURE output).
      const storedToken = "claude-resume-" + randomUUID();
      const prevSessionId = await insertSessionRow(db, workspaceId, {
        id: randomUUID(), executor: "claude-code", status: "completed", providerSessionId: storedToken,
      });

      // A relaunch-faithful agent service: records the forwarded resume id (positional slot 5) and
      // reproduces the production spawn-arg construction so we can assert the literal --resume flag.
      const captured: { resumeId?: string; args?: string[] } = {};
      const agentService = {
        launch: vi.fn((...args: unknown[]) => {
          const providerSessionId = args[5] as string | undefined;
          const provider = args[11] as string | undefined;
          captured.resumeId = providerSessionId;
          const cfg = buildAgentLaunchConfig({
            provider: (provider as "claude-code" | undefined) ?? "claude-code",
            providerSessionId,
            agentCommand: "mock-agent", // mock path: builds --resume without touching fs/child_process
          });
          captured.args = cfg.args;
          return createMockProc();
        }),
        kill: vi.fn(() => true),
        closeStdin: vi.fn(() => true),
        getProcess: vi.fn(() => undefined),
        sendInput: vi.fn(() => true),
        isPidAlive: vi.fn(() => true),
      } as unknown as AgentService;

      const lifecycle = createSessionLifecycle(
        createSessionState(),
        undefined,
        vi.fn(),
        { db, agentService, preflight: okPreflight() },
      );

      // Relaunch resuming the prior session.
      await lifecycle.startSession({ workspaceId, prompt: "continue the work", resumeFromId: prevSessionId });

      // The stored token was forwarded to the launcher's resume slot...
      expect(captured.resumeId).toBe(storedToken);
      // ...and materialized as `--resume <id>` in the spawned agent args.
      const args = captured.args ?? [];
      const resumeIdx = args.indexOf("--resume");
      expect(resumeIdx).toBeGreaterThanOrEqual(0);
      expect(args[resumeIdx + 1]).toBe(storedToken);
    });

    it("does NOT forward a resume id when there is no prior session to resume from", async () => {
      const { createTestDb } = await import("./helpers/test-db.js");
      const { db } = createTestDb();
      const { workspaceId } = await seedWorkspace(db);

      const captured: { resumeId?: string; args?: string[] } = {};
      const agentService = {
        launch: vi.fn((...args: unknown[]) => {
          const providerSessionId = args[5] as string | undefined;
          captured.resumeId = providerSessionId;
          const cfg = buildAgentLaunchConfig({ provider: "claude-code", providerSessionId, agentCommand: "mock-agent" });
          captured.args = cfg.args;
          return createMockProc();
        }),
        kill: vi.fn(() => true),
        closeStdin: vi.fn(() => true),
        getProcess: vi.fn(() => undefined),
        sendInput: vi.fn(() => true),
        isPidAlive: vi.fn(() => true),
      } as unknown as AgentService;

      const lifecycle = createSessionLifecycle(
        createSessionState(),
        undefined,
        vi.fn(),
        { db, agentService, preflight: okPreflight() },
      );

      // A fresh start (no resumeFromId) must not carry any --resume token.
      await lifecycle.startSession({ workspaceId, prompt: "start fresh" });

      expect(captured.resumeId).toBeUndefined();
      expect(captured.args ?? []).not.toContain("--resume");
    });
  });
});
