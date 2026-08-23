// @gate:always-run — exercises the live command-safety hook script outside src/ (a plain .js
// hook loaded by path); imports nothing it checks, so import-graph scoping is blind to it (#787).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require_ = createRequire(__filename);
// The dev checkout's LIVE hook — the same file the PreToolUse guard runs.
const HOOK = join(__dirname, "../../../../.claude/hooks/validate-command-safety.js");
const guard = require_(HOOK) as {
  pruneBackups: (
    dir: string,
    opts?: { keepSets?: number; maxAgeMs?: number; maxTotalBytes?: number; nowMs?: number },
  ) => string[];
  safePruneBackups: (dir: string, opts?: Record<string, unknown>) => string[];
  listBackupSets: (dir: string) => Array<{ stamp: string; bytes: number; mtimeMs: number; files: string[] }>;
  BACKUP_RETENTION: { keepSets: number; maxAgeMs: number; maxTotalBytes: number };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 7, 23, 12, 0, 0);

let dir: string;

/**
 * Write one FAKE backup set into the temp dir. These are the guard's own naming convention
 * (`kanban-<stamp>.db` + sidecars) but they are throwaway bytes in an OS temp directory — no
 * real database is involved anywhere in this suite.
 */
function makeSet(stamp: string, opts: { bytes?: number; ageDays?: number } = {}): void {
  const bytes = opts.bytes ?? 16;
  const ageDays = opts.ageDays ?? 0;
  const seconds = (NOW_MS - ageDays * DAY_MS) / 1000;
  for (const suffix of ["", "-wal"]) {
    const f = join(dir, `kanban-${stamp}.db${suffix}`);
    writeFileSync(f, Buffer.alloc(suffix === "" ? bytes : 4, stamp.charCodeAt(0)));
    utimesSync(f, seconds, seconds);
  }
  const meta = join(dir, `kanban-${stamp}.db.meta.json`);
  writeFileSync(meta, JSON.stringify({ stamp, size: bytes, mtimeMs: seconds * 1000, dbPath: "/fake/board.db" }));
  utimesSync(meta, seconds, seconds);
}

function stamps(): string[] {
  return guard.listBackupSets(dir).map((s) => s.stamp);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ak-prune-fixture-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("db-safety backup retention (#787)", () => {
  it("groups a set's db, wal and manifest into ONE set, oldest first", () => {
    makeSet("2026-08-01T00-00-00-000Z", { bytes: 100 });
    makeSet("2026-08-02T00-00-00-000Z", { bytes: 200 });

    const sets = guard.listBackupSets(dir);
    expect(sets.map((s) => s.stamp)).toEqual([
      "2026-08-01T00-00-00-000Z",
      "2026-08-02T00-00-00-000Z",
    ]);
    expect(sets[0].files).toHaveLength(3);
    // bytes is the whole set (db + wal + manifest), which is what the byte budget spends
    expect(sets[1].bytes).toBeGreaterThanOrEqual(204);
    expect(sets[1].bytes).toBeGreaterThan(sets[0].bytes);
  });

  it("COUNT lever: keeps only the newest keepSets sets", () => {
    for (let i = 1; i <= 6; i++) makeSet(`2026-08-0${i}T00-00-00-000Z`);

    const removed = guard.pruneBackups(dir, { keepSets: 2, nowMs: NOW_MS });

    expect(removed).toEqual([
      "2026-08-01T00-00-00-000Z",
      "2026-08-02T00-00-00-000Z",
      "2026-08-03T00-00-00-000Z",
      "2026-08-04T00-00-00-000Z",
    ]);
    expect(stamps()).toEqual(["2026-08-05T00-00-00-000Z", "2026-08-06T00-00-00-000Z"]);
    // every file of a pruned set goes, sidecars and manifest included — no orphans left behind
    expect(readdirSync(dir).filter((f) => f.includes("2026-08-01"))).toEqual([]);
  });

  it("AGE lever: sets older than maxAgeMs go even when the count is within budget", () => {
    makeSet("2026-08-01T00-00-00-000Z", { ageDays: 22 });
    makeSet("2026-08-11T00-00-00-000Z", { ageDays: 12 });
    makeSet("2026-08-22T00-00-00-000Z", { ageDays: 1 });

    const removed = guard.pruneBackups(dir, { keepSets: 10, maxAgeMs: 7 * DAY_MS, nowMs: NOW_MS });

    expect(removed).toEqual(["2026-08-01T00-00-00-000Z", "2026-08-11T00-00-00-000Z"]);
    expect(stamps()).toEqual(["2026-08-22T00-00-00-000Z"]);
  });

  it("BYTE lever: drops oldest-first until the survivors fit the budget", () => {
    makeSet("2026-08-01T00-00-00-000Z", { bytes: 1000 });
    makeSet("2026-08-02T00-00-00-000Z", { bytes: 1000 });
    makeSet("2026-08-03T00-00-00-000Z", { bytes: 1000 });

    // A budget that fits EXACTLY the two newest sets, derived from the fixture rather than
    // guessed, so the manifest's byte size cannot make this assertion drift.
    const sets = guard.listBackupSets(dir);
    const maxTotalBytes = sets[1].bytes + sets[2].bytes;

    const removed = guard.pruneBackups(dir, {
      keepSets: 10,
      maxAgeMs: 365 * DAY_MS,
      maxTotalBytes,
      nowMs: NOW_MS,
    });

    expect(removed).toEqual(["2026-08-01T00-00-00-000Z"]);
    expect(stamps()).toEqual(["2026-08-02T00-00-00-000Z", "2026-08-03T00-00-00-000Z"]);
  });

  it("the guarantee survives a prune: the newest set is intact and restorable afterwards", () => {
    makeSet("2026-08-01T00-00-00-000Z", { bytes: 5000, ageDays: 300 });
    makeSet("2026-08-02T00-00-00-000Z", { bytes: 5000, ageDays: 300 });
    const newest = "2026-08-03T00-00-00-000Z";
    makeSet(newest, { bytes: 5000, ageDays: 300 });
    const before = readFileSync(join(dir, `kanban-${newest}.db`));

    // Every lever at its most aggressive at once — and the newest set is exempt from all of them.
    guard.pruneBackups(dir, { keepSets: 1, maxAgeMs: 1, maxTotalBytes: 1, nowMs: NOW_MS });

    expect(stamps()).toEqual([newest]);
    expect(readFileSync(join(dir, `kanban-${newest}.db`)).equals(before)).toBe(true);
    expect(readFileSync(join(dir, `kanban-${newest}.db-wal`)).length).toBe(4);
    const meta = JSON.parse(readFileSync(join(dir, `kanban-${newest}.db.meta.json`), "utf8"));
    expect(meta.stamp).toBe(newest);
  });

  it("a lone set is never pruned, whatever the policy says", () => {
    makeSet("2026-01-01T00-00-00-000Z", { bytes: 9999, ageDays: 900 });

    expect(guard.pruneBackups(dir, { keepSets: 0, maxAgeMs: 1, maxTotalBytes: 1, nowMs: NOW_MS })).toEqual([]);
    expect(stamps()).toEqual(["2026-01-01T00-00-00-000Z"]);
  });

  it("ignores files that are not backup sets", () => {
    makeSet("2026-08-01T00-00-00-000Z");
    makeSet("2026-08-02T00-00-00-000Z");
    writeFileSync(join(dir, "README.txt"), "not a backup");

    guard.pruneBackups(dir, { keepSets: 1, nowMs: NOW_MS });

    expect(readdirSync(dir)).toContain("README.txt");
  });

  it("a pruning failure never propagates — safePruneBackups swallows it", () => {
    const missing = join(dir, "does-not-exist");
    expect(() => guard.pruneBackups(missing)).toThrow();
    expect(guard.safePruneBackups(missing)).toEqual([]);
  });

  it("ships a bounded default policy on all three levers", () => {
    expect(guard.BACKUP_RETENTION.keepSets).toBeGreaterThan(0);
    expect(guard.BACKUP_RETENTION.keepSets).toBeLessThanOrEqual(5);
    expect(guard.BACKUP_RETENTION.maxAgeMs).toBeGreaterThan(0);
    // The lever that actually bounds the directory: 10 sets of a 186 MB db was 1.9 GB.
    expect(guard.BACKUP_RETENTION.maxTotalBytes).toBeLessThanOrEqual(2 * 1024 * 1024 * 1024);
  });
});
