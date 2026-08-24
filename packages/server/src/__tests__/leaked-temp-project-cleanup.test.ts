// #166 — the real DB accumulated leaked test/lab fixture projects whose repoPath pointed into
// an already-deleted %TEMP% dir (kanban-gpg-hostile, p-init-clean, p-init-commit, p-init-readme,
// etc — see create-project-initial-commit.test.ts, which used to register a project per test and
// never unregister it). This pins the safe-heuristic cleanup: a project is only auto-unregistered
// when its repoPath is BOTH gone from disk AND under the OS temp dir. A missing repoPath outside
// the temp dir (e.g. a briefly-unmounted drive) must only be REPORTED, never removed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { applyMigrationsToClient } from "./helpers/test-db.js";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const h = vi.hoisted(() => {
  return { file: undefined as string | undefined, client: undefined as Client | undefined, db: undefined as TestDb | undefined };
});

function liveProxy<T extends object>(getCurrent: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop, _receiver) {
      const current = getCurrent() as Record<PropertyKey, unknown>;
      const value = current[prop];
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
}

vi.mock("../db/index.js", () => {
  const db = liveProxy<TestDb>(() => h.db!);
  const client = liveProxy<Client>(() => h.client!);
  return {
    db,
    writeDb: db,
    rawClient: client,
    rawWriteClient: client,
    schema,
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: TestDb, fn: (tx: unknown) => Promise<T>) => database.transaction(fn),
  };
});

function openTestDb(): void {
  const dir = process.env.TEMP || process.env.TMP || process.cwd();
  const file = `${dir}/leaked-temp-cleanup-${randomUUID()}.db`;
  const c = createClient({ url: `file:${file}` });
  applyMigrationsToClient(c);
  c.execute("PRAGMA foreign_keys=ON");
  h.file = file;
  h.client = c;
  h.db = drizzle(c, { schema });
}

function closeTestDb(): void {
  try { h.client?.close(); } catch { /* ignore */ }
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(`${h.file}${suffix}`, { force: true }); } catch { /* best-effort */ }
  }
}

const db = (): TestDb => h.db!;

import { findProjectsWithMissingRepoPath, unregisterLeakedTempProjects } from "../services/project-registration.js";

interface Seeded {
  liveId: string;
  leakedTempId: string;
  missingNonTempId: string;
}

async function seed(d: TestDb): Promise<Seeded & { livePath: string; leakedTempPath: string; missingNonTempPath: string }> {
  const ids: Seeded = { liveId: randomUUID(), leakedTempId: randomUUID(), missingNonTempId: randomUUID() };
  const now = new Date().toISOString();

  const livePath = join(tmpdir(), `ak-leaked-cleanup-live-${randomUUID()}`);
  mkdirSync(livePath, { recursive: true });

  // TEMP-PREFIX OK: never created on disk — it simulates a temp fixture whose dir was already
  // cleaned up, so there is nothing for the reaper to sweep and an `ak-` prefix would only
  // suggest otherwise. The name must stay DISTINCT from the live path above so a failure names
  // which of the two was mishandled.
  const leakedTempPath = join(tmpdir(), `leaked-cleanup-gone-${randomUUID()}`);

  // Missing, but NOT under the OS temp dir — must be reported, never auto-removed.
  //
  // Deliberately NOT derived from the repo root / process.cwd() (#711): the base-branch-health
  // probe clones this repo into `%TEMP%\kanban-base-health-<projectId>-<branch>`, so under that
  // probe the repo root IS inside the OS temp dir and a cwd-relative fixture is classified as a
  // leaked temp project — unregistered, failing both assertions here (red on 12 consecutive
  // probes while green in the main checkout).
  //
  // `isUnderTempDir` (project-registration.ts) is a normalized string-prefix test against
  // `tmpdir() + sep`, so the one place that is provably outside it no matter where the repo
  // lives is the FILESYSTEM ROOT of the volume holding the temp dir: `C:\` on Windows, `/` on
  // POSIX. `tmpdir()` is always at least one segment below its own root, so a child of that root
  // can never carry the `tmpdir()` prefix. Nothing is created on disk (the path must stay
  // missing), so no write permission at the root is needed.
  const missingNonTempPath = join(parse(tmpdir()).root, `not-a-real-project-${randomUUID()}`);

  await d.insert(schema.projects).values([
    { id: ids.liveId, name: "live-project", repoPath: livePath, repoName: "live-project", defaultBranch: "main", createdAt: now, updatedAt: now },
    { id: ids.leakedTempId, name: "p-leaked-fixture", repoPath: leakedTempPath, repoName: "p-leaked-fixture", defaultBranch: "main", createdAt: now, updatedAt: now },
    { id: ids.missingNonTempId, name: "unmounted-drive-project", repoPath: missingNonTempPath, repoName: "unmounted-drive-project", defaultBranch: "main", createdAt: now, updatedAt: now },
  ]);

  return { ...ids, livePath, leakedTempPath, missingNonTempPath };
}

describe("leaked %TEMP% project cleanup (#166)", () => {
  let cleanupDirs: string[] = [];

  beforeEach(() => {
    openTestDb();
    cleanupDirs = [];
  });

  afterEach(() => {
    closeTestDb();
    for (const d of cleanupDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("findProjectsWithMissingRepoPath reports every missing repoPath, flagging which are under the temp dir", async () => {
    const seeded = await seed(db());
    cleanupDirs.push(seeded.livePath);

    const missing = await findProjectsWithMissingRepoPath();
    const byId = new Map(missing.map((p) => [p.id, p]));

    expect(byId.has(seeded.liveId)).toBe(false); // exists on disk — not reported at all
    expect(byId.get(seeded.leakedTempId)?.isTemp).toBe(true);
    expect(byId.get(seeded.missingNonTempId)?.isTemp).toBe(false);
  });

  it("unregisterLeakedTempProjects removes only the missing-AND-temp project, leaving the live project and the missing-non-temp project registered", async () => {
    const seeded = await seed(db());
    cleanupDirs.push(seeded.livePath);

    const removed = await unregisterLeakedTempProjects();

    expect(removed).toHaveLength(1);
    expect(removed[0]?.id).toBe(seeded.leakedTempId);

    const remaining = await db().select().from(schema.projects);
    const remainingIds = new Set(remaining.map((p) => p.id));
    expect(remainingIds.has(seeded.liveId)).toBe(true);
    expect(remainingIds.has(seeded.missingNonTempId)).toBe(true); // never auto-removed — outside temp dir
    expect(remainingIds.has(seeded.leakedTempId)).toBe(false);

    // Cascade delete also cleared the leaked project's statuses (seeded via initializeProjectStatuses
    // equivalent isn't run here, but confirm no dangling project row at least).
    const leakedRow = await db().select().from(schema.projects).where(eq(schema.projects.id, seeded.leakedTempId));
    expect(leakedRow).toHaveLength(0);
  });

  it("is idempotent — a second run finds nothing left to remove", async () => {
    const seeded = await seed(db());
    cleanupDirs.push(seeded.livePath);

    await unregisterLeakedTempProjects();
    const secondRun = await unregisterLeakedTempProjects();

    expect(secondRun).toHaveLength(0);
  });
});
