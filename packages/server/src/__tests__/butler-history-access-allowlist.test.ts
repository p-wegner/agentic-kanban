// @covers butler.history.access [permission, boundary, api]
//
// SECURITY boundary (routes/butler.ts:664-667): a past butler session's
// transcript is readable through GET /butler/sessions/:sid/messages ONLY if its
// id is allowlisted to THIS project's tracked ids (the
// `butler_session_history_<projectId>` preference). A session id that belongs to
// a DIFFERENT project must be REFUSED with 404 — even when the transcript file
// is physically present and readable on disk. The list endpoint
// (GET /butler/sessions) likewise surfaces ONLY allowlisted ids.
//
// Existing coverage only checks the list is an array (no deny path). This test
// pins BOTH directions of the permission boundary:
//   - ALLOW: an own/allowlisted session id → 200 + the real transcript.
//   - DENY : a foreign project's session id → 404 "Session not found", despite
//            the JSONL file existing on disk under the same repoPath.
//
// Mutation check: deleting the `if (!allowedIds.has(sessionId))` guard makes the
// foreign id readable (200 + leaked transcript) → the DENY assertion goes RED.
//
// The 50-id history WRITE cap (appendToSessionHistory, butler.ts:77) is a
// write-path internal only reachable by driving live SDK `session` events; it is
// NOT observable through these read endpoints (GET /sessions re-sorts by file
// mtime and uses the allowlist purely as a membership set). It is therefore
// DEFERRED here. The list-level boundary that IS observable — only allowlisted
// ids appear in GET /sessions — is asserted instead.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projects } from "@agentic-kanban/shared/schema";

import { createButlerRoute } from "../routes/butler.js";
import {
  getButlerSessionMessages,
  resolveTranscriptDir,
} from "../services/butler-transcripts.service.js";
import { setRuntimeState } from "../repositories/runtime-state.repository.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/projects", createButlerRoute(db, () => createMockSessionManager()));
  });
}

async function createProject(db: TestDb, name: string, repoPath: string): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    name,
    repoPath,
    repoName: "agentic-kanban",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Build a minimal SDK JSONL transcript the butler-transcripts parser accepts. */
function transcriptJsonl(sessionId: string, userText: string, assistantText: string): string {
  return (
    JSON.stringify({
      type: "user",
      entrypoint: "cli",
      sessionId,
      timestamp: "2026-06-27T10:00:00.000Z",
      message: { role: "user", content: userText },
    }) +
    "\n" +
    JSON.stringify({
      type: "assistant",
      entrypoint: "cli",
      sessionId,
      timestamp: "2026-06-27T10:00:01.000Z",
      message: { model: "claude", content: [{ type: "text", text: assistantText }] },
    }) +
    "\n"
  );
}

const OWN_SID = "own-session-A";
const FOREIGN_SID = "foreign-session-B";

// Both projects share one repoPath so their transcripts live in ONE on-disk dir.
// This is the crisp security setup: the foreign session's file is physically
// present and readable from THIS project's repoPath, yet the endpoint must still
// refuse it because membership — not file existence — is the gate.
const repoPath = join(tmpdir(), `butler-hist-access-${randomUUID()}`);
const transcriptDir = resolveTranscriptDir(repoPath);

describe("butler.history.access — cross-project transcript allowlist", () => {
  beforeAll(async () => {
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, `${OWN_SID}.jsonl`),
      transcriptJsonl(OWN_SID, "OWN project question", "OWN project answer"),
      "utf-8",
    );
    await writeFile(
      join(transcriptDir, `${FOREIGN_SID}.jsonl`),
      transcriptJsonl(FOREIGN_SID, "FOREIGN secret question", "FOREIGN secret answer"),
      "utf-8",
    );
  });

  afterAll(async () => {
    await rm(transcriptDir, { recursive: true, force: true });
  });

  it("ALLOWS an own/allowlisted session id and DENIES a foreign project's id", async () => {
    const { app, db } = createTestApp();
    const projectA = await createProject(db, "Project A", repoPath);
    const projectB = await createProject(db, "Project B", repoPath);

    // A tracks OWN_SID; B tracks FOREIGN_SID. The ids are disjoint across projects.
    await setRuntimeState(`butler_session_history_${projectA}`, JSON.stringify([OWN_SID]), db);
    await setRuntimeState(`butler_session_history_${projectB}`, JSON.stringify([FOREIGN_SID]), db);

    // Sanity: the foreign transcript IS physically readable from A's repoPath, so
    // the deny below is enforced by the allowlist, not by a missing/empty file.
    const foreignOnDisk = await getButlerSessionMessages(repoPath, FOREIGN_SID);
    expect(foreignOnDisk.length).toBeGreaterThan(0);

    // ALLOW: A's own session id → 200 with the real transcript.
    const allow = await app.request(
      `/api/projects/${projectA}/butler/sessions/${OWN_SID}/messages`,
    );
    expect(allow.status).toBe(200);
    const allowBody = (await allow.json()) as { messages: Array<{ role: string; text: string }> };
    expect(allowBody.messages.length).toBeGreaterThanOrEqual(2);
    expect(allowBody.messages.map((m) => m.text)).toContain("OWN project question");

    // DENY: B's session id requested via A's URL → 404 (mutation-sensitive line).
    // The file is readable on disk (asserted above) so a 200 here would be a leak.
    const deny = await app.request(
      `/api/projects/${projectA}/butler/sessions/${FOREIGN_SID}/messages`,
    );
    expect(deny.status).toBe(404);
    const denyBody = (await deny.json()) as { error?: string; messages?: unknown };
    expect(denyBody.error).toMatch(/not found/i);
    // The foreign transcript text must NOT leak through the response.
    expect(JSON.stringify(denyBody)).not.toContain("FOREIGN secret");
  });

  it("lists ONLY this project's allowlisted sessions (boundary)", async () => {
    const { app, db } = createTestApp();
    const projectA = await createProject(db, "Project A list", repoPath);

    // A tracks only OWN_SID, even though FOREIGN_SID's file sits in the same dir.
    await setRuntimeState(`butler_session_history_${projectA}`, JSON.stringify([OWN_SID]), db);

    const res = await app.request(`/api/projects/${projectA}/butler/sessions?limit=20`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
    const ids = body.sessions.map((s) => s.sessionId);
    expect(ids).toContain(OWN_SID);
    expect(ids).not.toContain(FOREIGN_SID);
  });

  it("returns an empty list when this project has no tracked sessions", async () => {
    const { app, db } = createTestApp();
    const projectA = await createProject(db, "Project A empty", repoPath);
    // No history preference seeded → empty allowlist.

    const res = await app.request(`/api/projects/${projectA}/butler/sessions`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { sessions: unknown[] }).toEqual({ sessions: [] });

    // And a transcript read with an empty allowlist is refused.
    const deny = await app.request(
      `/api/projects/${projectA}/butler/sessions/${OWN_SID}/messages`,
    );
    expect(deny.status).toBe(404);
  });
});
