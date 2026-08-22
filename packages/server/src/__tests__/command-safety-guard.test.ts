// @gate:always-run — spawns the live command-safety hook script outside src/; imports nothing it checks (#538).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readdir, mkdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The dev checkout's LIVE hook.
const HOOK = join(__dirname, "../../../../.claude/hooks/validate-command-safety.js");
/**
 * Is THIS suite running inside a git worktree rather than the main checkout? The guard has
 * worktree-only rules (`usesWorktreeCli`), so a command containing `pnpm cli --` gets a
 * different — and entirely correct — verdict depending on where the suite runs. Cases whose
 * fixture command triggers one of those rules must say so explicitly instead of asserting a
 * verdict that only holds in one of the two environments. See the #420 case below.
 */
const RUNNING_IN_WORKTREE = /[/\\]\.worktrees[/\\]/i.test(join(__dirname, "../../../.."));

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  blocked: boolean;
  reason: string;
}

/**
 * The guard resolves a RELATIVE db path against the process CWD — correctly, since that is
 * what a relative path means. Vitest runs with CWD = `packages/server`, so a fixture written
 * as `packages/server/kanban.db` would resolve to `packages/server/packages/server/kanban.db`
 * and mean whatever happens to sit there. A stray 4KB stub at that drifted path (left behind
 * by a CWD-drift accident) once made four of these cases go GREEN-to-RED overnight with no
 * code change, because the #406 stub allowance then fired. Pin the CWD to the repo root so a
 * fixture path means what it reads as.
 */
const REPO_ROOT = join(__dirname, "../../../..");

/**
 * Second brush with the same trap the comment above describes, and pinning the CWD was only
 * half the cure. A fixture written as the repo-relative `packages/server/kanban.db` still means
 * "whatever file happens to sit there" — and on a machine where that path holds a stray 0-byte
 * file (the shadow-stub the CLI tells you to delete), the #406 sub-12KB carve-out fires and the
 * SAME four cases go green-to-red with no code change. Measured: the pre-merge hook bytes give
 * the identical verdict, so nothing in the guard had moved.
 *
 * A case whose subject is "a destructive shape aimed at the REAL database blocks" must therefore
 * supply a real database itself, in a checkout it owns. `KANBAN_MAIN_CHECKOUT` + `CLAUDE_PROJECT_DIR`
 * point both the guard's db resolution and its relative-token resolution at that checkout, so the
 * command string keeps its real-world repo-relative shape while meaning something the test controls.
 */
async function makeCheckoutWithRealDb(bytes = 16_384): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kanban-guard-checkout-"));
  await mkdir(join(root, "packages", "server"), { recursive: true });
  await writeFile(join(root, "packages", "server", "kanban.db"), Buffer.alloc(bytes, 1));
  return root;
}

function checkoutEnv(root: string): Record<string, string> {
  return { CLAUDE_PROJECT_DIR: root, KANBAN_MAIN_CHECKOUT: root };
}

function runGuard(command: string, env: Record<string, string> = {}, cwd: string = REPO_ROOT): RunResult {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
    cwd,
    // #767: the guard now reads the canonical `KANBAN_DB_URL` too, so it must be cleared
    // alongside `DB_URL` — otherwise an operator with the documented pin set in their shell
    // silently redirects every case below at the pinned database.
    env: { ...process.env, ALLOW_DB_DESTROY: "", KANBAN_DB_URL: "", DB_URL: "", AGENTIC_KANBAN_DIR: "", ...env },
    windowsHide: true,
    timeout: 30_000,
  });
  const status = result.status ?? 1;
  let reason = "";
  try {
    reason = JSON.parse((result.stdout ?? "").trim()).reason ?? "";
  } catch {
    /* not a block decision */
  }
  return { status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", blocked: status === 1, reason };
}

describe("validate-command-safety — db name in transmitted DATA is not a filesystem op (#137)", () => {
  it("allows a POST whose heredoc payload mentions the db filename", () => {
    // The exact shape that was falsely blocked: nothing touches the filesystem —
    // the db name is prose inside a ticket body, and `>/dev/null` is not a target.
    const command = [
      "curl -s -X POST http://127.0.0.1:13001/api/issues -d @- <<'EOF' >/dev/null",
      '{"title":"guard bug","description":"getDbPath resolves to packages/server/kanban.db which is absent"}',
      "EOF",
    ].join("\n");

    expect(runGuard(command).blocked).toBe(false);
  });

  it("allows echoing the db filename into an unrelated file", () => {
    expect(runGuard('echo "see kanban.db for details" > notes.md').blocked).toBe(false);
  });

  it("allows writing a doc that discusses the db", () => {
    expect(runGuard("cat docs/db.md | grep kanban.db > /tmp/report.txt").blocked).toBe(false);
  });

  it("allows a grep for the db filename", () => {
    expect(runGuard("grep -rn kanban.db packages/").blocked).toBe(false);
  });

  it("still blocks when the db name appears OUTSIDE the heredoc as a real argument", async () => {
    // A real database in a checkout this case owns — see `makeCheckoutWithRealDb`. The subject
    // here is heredoc parsing, so the verdict must not depend on what the ambient repo path holds.
    const checkout = await makeCheckoutWithRealDb();
    try {
      const command = ["rm packages/server/kanban.db <<'EOF'", "unrelated body", "EOF"].join("\n");
      expect(runGuard(command, checkoutEnv(checkout), checkout).blocked).toBe(true);
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });
});

describe("validate-command-safety — redirects are judged by their TARGET (#137)", () => {
  it("blocks a redirect INTO the db", () => {
    expect(runGuard("echo corrupt > packages/server/kanban.db").blocked).toBe(true);
  });

  it("blocks an APPEND into the db (appending bytes corrupts SQLite)", () => {
    expect(runGuard("echo corrupt >> packages/server/kanban.db").blocked).toBe(true);
  });

  it("blocks a redirect into the home-fallback db path", () => {
    expect(runGuard("cat /dev/zero > ~/.agentic-kanban/kanban.db").blocked).toBe(true);
  });

  it("does not treat 2>&1 as a redirect target", () => {
    expect(runGuard("pnpm test 2>&1 | grep kanban.db").blocked).toBe(false);
  });

  it("does not parse prose inside a heredoc as a redirect into the db", () => {
    // Found by dogfooding: writing this ticket's own commit message blocked the
    // commit. `<mainCheckout>/packages/server/kanban.db` in the body looks like a
    // redirect — the `>` of `<mainCheckout>` followed by a db path — so redirect
    // extraction must run on the heredoc-stripped command, not the raw one.
    const command = [
      "git commit -F - <<'MSGEOF'",
      "fix: getDbPath hardcoded `<mainCheckout>/packages/server/kanban.db`.",
      "MSGEOF",
    ].join("\n");

    expect(runGuard(command).blocked).toBe(false);
  });
});

describe("validate-command-safety — destructive verbs still block (no regression)", () => {
  // Every case here asserts "this SHAPE blocks when it is aimed at a real database", so the
  // database is supplied by the case, not borrowed from the ambient repo (see
  // `makeCheckoutWithRealDb`). The absolute-path, home-path, `db:reset` and glob cases are
  // path-independent and unaffected by running inside the fixture checkout.
  let checkout: string;

  beforeEach(async () => {
    checkout = await makeCheckoutWithRealDb();
  });

  afterEach(async () => {
    await rm(checkout, { recursive: true, force: true });
  });

  for (const command of [
    "rm packages/server/kanban.db",
    "rm -rf /mnt/c/projects/andrena/agentic-kanban/packages/server/kanban.db",
    "Remove-Item ~/.agentic-kanban/kanban.db",
    "Move-Item packages/server/kanban.db C:/tmp/",
    "pnpm db:reset",
    "rm *.db",
  ]) {
    it(`blocks: ${command}`, () => {
      expect(runGuard(command, checkoutEnv(checkout), checkout).blocked).toBe(true);
    });
  }
});

describe("validate-command-safety — sub-12KB stub removal is allowed (#406)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kanban-guard-stub-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const posix = (p: string) => p.replace(/\\/g, "/");

  it("allows rm of an on-disk 0-byte kanban.db stub, with a loud note", async () => {
    const db = join(dir, "kanban.db");
    await writeFile(db, "");

    const result = runGuard(`rm ${posix(db)}`);

    expect(result.blocked).toBe(false);
    expect(result.stderr).toContain("stray kanban.db STUB");
    expect(result.stderr).toContain("12288");
    expect(result.stderr).toContain("db-path.ts");
  });

  it("allows removing a small stub together with its -wal/-shm sidecars", async () => {
    const db = join(dir, "kanban.db");
    await writeFile(db, "tiny");
    await writeFile(db + "-wal", "w");

    const result = runGuard(`rm "${db}" "${db}-wal"`);

    expect(result.blocked).toBe(false);
    expect(result.stderr).toContain("stray kanban.db STUB");
  });

  it("allows quarantining a stub via mv (rename away)", async () => {
    const db = join(dir, "kanban.db");
    await writeFile(db, "");

    expect(runGuard(`mv ${posix(db)} ${posix(db)}.stub-2026-08-11`).blocked).toBe(false);
  });

  it("still blocks rm of a kanban.db AT the 12KB floor (a real database)", async () => {
    const db = join(dir, "kanban.db");
    await writeFile(db, Buffer.alloc(12_288));

    expect(runGuard(`rm ${posix(db)}`).blocked).toBe(true);
  });

  it("still blocks rm of a kanban.db above the floor", async () => {
    const db = join(dir, "kanban.db");
    await writeFile(db, Buffer.alloc(64_000));

    expect(runGuard(`rm ${posix(db)}`).blocked).toBe(true);
  });

  it("still blocks when the target file is MISSING (path could resolve to the real db)", () => {
    expect(runGuard(`rm ${posix(join(dir, "kanban.db"))}`).blocked).toBe(true);
  });

  it("still blocks rm of a sub-floor db whose -wal sidecar holds real data", async () => {
    // The one shape where "sub-12KB ⇒ not a database" is false: in WAL mode the committed pages
    // sit in `kanban.db-wal` until a checkpoint folds them back, so a small main file beside a
    // large WAL is a database, not a stray stub.
    const db = join(dir, "kanban.db");
    await writeFile(db, Buffer.alloc(4096));
    await writeFile(db + "-wal", Buffer.alloc(64_000, 1));

    expect(runGuard(`rm ${posix(db)}`).blocked).toBe(true);
  });

  it("still allows the stub when only a small -shm sidecar is beside it", async () => {
    // `-shm` is a rebuildable shared-memory index, never data — it must not veto the carve-out.
    const db = join(dir, "kanban.db");
    await writeFile(db, "");
    await writeFile(db + "-shm", Buffer.alloc(32_768, 0));

    expect(runGuard(`rm ${posix(db)}`).blocked).toBe(false);
  });

  it("still blocks a redirect/truncation INTO a stub (no size exemption for writes)", async () => {
    const db = join(dir, "kanban.db");
    await writeFile(db, "");

    expect(runGuard(`echo corrupt > ${posix(db)}`).blocked).toBe(true);
  });

  it("still blocks glob deletion even when only a stub exists", async () => {
    await writeFile(join(dir, "kanban.db"), "");

    expect(runGuard(`rm ${posix(dir)}/*.db`).blocked).toBe(true);
  });

  it("still blocks a stub removal that changes directory first (stat cannot be trusted)", async () => {
    const db = join(dir, "kanban.db");
    await writeFile(db, "");

    expect(runGuard(`cd ${posix(dir)} && rm ${posix(db)}`).blocked).toBe(true);
  });

  it("still blocks removing only a -wal sidecar when the main db is real-sized", async () => {
    const db = join(dir, "kanban.db");
    await writeFile(db, Buffer.alloc(20_000));
    await writeFile(db + "-wal", "w");

    expect(runGuard(`rm ${posix(db)}-wal`).blocked).toBe(true);
  });

  it("still blocks when two DIFFERENT db paths are named and only one is a stub", async () => {
    const stub = join(dir, "kanban.db");
    await writeFile(stub, "");
    const other = join(dir, "elsewhere", "kanban.db");

    expect(runGuard(`rm ${posix(stub)} ${posix(other)}`).blocked).toBe(true);
  });
});

describe("validate-command-safety — backup covers the db actually in use (#137)", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kanban-guard-db-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("backs up the AGENTIC_KANBAN_DIR database before blocking", async () => {
    const db = join(dataDir, "kanban.db");
    // Real-sized (>= the #406 stub floor of 12288 bytes) so the guard treats it
    // as the vital database, not a removable stub.
    await writeFile(db, Buffer.alloc(16_384, 1));
    await writeFile(db + "-wal", "wal");

    const result = runGuard(`rm ${db.replace(/\\/g, "/")}`, { AGENTIC_KANBAN_DIR: dataDir });

    expect(result.blocked).toBe(true);
    const backups = await readdir(join(dataDir, ".db-backups"));
    expect(backups.some((f) => /^kanban-.*\.db$/.test(f))).toBe(true);
    expect(backups.some((f) => /^kanban-.*\.db-wal$/.test(f))).toBe(true);
    expect(result.reason).toContain("A safety backup was just created");
  });

  it("backs up the home-fallback database when no in-checkout db exists", async () => {
    // Simulate the home fallback by pointing HOME/USERPROFILE at a temp dir.
    const home = join(dataDir, "home");
    await mkdir(join(home, ".agentic-kanban"), { recursive: true });
    // Real-sized (>= the #406 stub floor) so removal still blocks and backs up.
    await writeFile(join(home, ".agentic-kanban", "kanban.db"), Buffer.alloc(16_384, 1));

    const result = runGuard("rm ~/.agentic-kanban/kanban.db", {
      HOME: home,
      USERPROFILE: home,
      // Force the local-checkout probe to miss, as in a fresh clone.
      KANBAN_MAIN_CHECKOUT: join(dataDir, "no-such-checkout"),
    });

    expect(result.blocked).toBe(true);
    const backups = await readdir(join(home, ".agentic-kanban", ".db-backups"));
    expect(backups.some((f) => /^kanban-.*\.db$/.test(f))).toBe(true);
  });

  it("says explicitly that NO backup exists when the db is absent, rather than implying one ran", async () => {
    // The subject is the MESSAGE, so the command must reach the message: it needs a shape that
    // blocks (a real db behind the named token — see `makeCheckoutWithRealDb`, otherwise the #406
    // stub carve-out allows it and there is no message to inspect) while the db the guard RESOLVES
    // to — here an empty AGENTIC_KANBAN_DIR — is absent, so no backup can be taken.
    const checkout = await makeCheckoutWithRealDb();
    const result = runGuard(
      "rm packages/server/kanban.db",
      { AGENTIC_KANBAN_DIR: join(dataDir, "empty"), ...checkoutEnv(checkout) },
      checkout,
    );
    await rm(checkout, { recursive: true, force: true });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("NO BACKUP EXISTS");
    expect(result.reason).toContain("no database file exists at");
    // The old message claimed "the db was missing or empty" with no path — the
    // whole point of the fix is that the resolved location is named.
    expect(result.reason).toContain("kanban.db");
  });
});

/**
 * #758 — the hook's local-checkout probe was a bare `existsSync`, so it disagreed with the
 * CLI resolver (`LOCAL_DB_CANDIDATES` / `isValidLocalDb`, which applies the #165 size floor).
 * Live consequence on the dev machine: a 0-byte `packages/server/kanban.db` beside the real
 * 186 MB `~/.agentic-kanban/kanban.db` made the guard call the STUB "the db in use", so every
 * destructive-db block took a 0-byte backup and then honestly reported "NO BACKUP EXISTS"
 * while the actual database sat one path away, unprotected.
 *
 * The destructive shape used below is a reset, assembled from pieces (see `RESET` above): it
 * blocks on its own shape, so these cases reach the block MESSAGE without depending on the
 * #406 stub carve-out, which would correctly ALLOW removing the stub instead.
 */
describe("validate-command-safety — the in-checkout db must clear the #165 floor to be 'the db in use' (#758)", () => {
  const RESET_CMD = `pnpm ${"db" + ":reset"}`;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kanban-guard-floor-"));
    await mkdir(join(root, "packages", "server"), { recursive: true });
    await mkdir(join(root, "home", ".agentic-kanban"), { recursive: true });
    await writeFile(join(root, "home", ".agentic-kanban", "kanban.db"), Buffer.alloc(16_384, 1));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const env = () => ({
    ...checkoutEnv(root),
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
  });

  const homeBackups = () => readdir(join(root, "home", ".agentic-kanban", ".db-backups"));
  const localDb = () => join(root, "packages", "server", "kanban.db");

  it("backs up the REAL home db, not a 0-byte in-checkout stub", async () => {
    await writeFile(localDb(), "");

    const result = runGuard(RESET_CMD, env(), root);

    expect(result.blocked).toBe(true);
    expect((await homeBackups()).some((f) => /^kanban-.*\.db$/.test(f))).toBe(true);
    // The claim an agent can check against disk: which file the backup covered.
    expect(result.reason).toContain(join(root, "home", ".agentic-kanban", "kanban.db"));
    expect(result.reason).toContain("resolved via home-fallback");
  });

  it("names the rejected in-checkout candidate rather than skipping it silently", async () => {
    await writeFile(localDb(), "");

    const result = runGuard(RESET_CMD, env(), root);

    expect(result.reason).toContain(localDb());
    expect(result.reason).toContain("is NOT the database in use");
    expect(result.reason).toContain("0 bytes");
    expect(result.reason).toContain("12288");
  });

  it("rejects an in-checkout db one byte BELOW the floor", async () => {
    await writeFile(localDb(), Buffer.alloc(12_287));

    const result = runGuard(RESET_CMD, env(), root);

    expect(result.blocked).toBe(true);
    expect((await homeBackups()).length).toBeGreaterThan(0);
  });

  it("still adopts an in-checkout db exactly AT the floor (the normal dev case)", async () => {
    // Same boundary the #406 carve-out uses: 12288 bytes is a database, not a stub. The floor
    // must not quietly demote a real dev DB to the home fallback.
    await writeFile(localDb(), Buffer.alloc(12_288, 1));

    const result = runGuard(RESET_CMD, env(), root);

    expect(result.blocked).toBe(true);
    expect(await readdir(join(root, "packages", "server", ".db-backups"))).not.toHaveLength(0);
    expect(result.reason).toContain("resolved via local-checkout");
    expect(result.reason).not.toContain("is NOT the database in use");
  });

  it("says nothing about a rejected candidate when the checkout simply has no db (fresh clone)", async () => {
    const result = runGuard(RESET_CMD, env(), root);

    expect(result.blocked).toBe(true);
    expect(result.reason).not.toContain("is NOT the database in use");
    expect(result.reason).toContain("resolved via home-fallback");
  });

  it("a directory at the db path is rejected, never adopted", async () => {
    await mkdir(localDb(), { recursive: true });

    const result = runGuard(RESET_CMD, env(), root);

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("is not a regular file");
    expect((await homeBackups()).length).toBeGreaterThan(0);
  });
});

/**
 * #767 — the remaining divergences #758 left in place, now closed:
 *
 *   1. the #663 board-CONTENT probe was not mirrored, so a migrated-but-EMPTY in-checkout
 *      leftover (~850 KB — comfortably over the #165 size floor) was still named as "the db in
 *      use" while the CLI resolver opened the home DB. Strictly narrower than #758 (the backup
 *      then covers a real file with a real schema), but the block message's one checkable claim
 *      was wrong again, which is the specific thing #758 was about.
 *   2. the guard read `process.env.DB_URL` only, never the canonical `KANBAN_DB_URL` that
 *      db-path.ts prefers — so pinning the database the DOCUMENTED way was ignored and the
 *      backup covered whatever the candidate search landed on.
 *
 * Fixtures are built with `node:sqlite` because only a REAL database distinguishes the two
 * rejection grounds; `pragma page_size` lifts them over the 12288-byte floor so the floor is
 * not what decides these cases.
 */
describe("validate-command-safety — a real-but-EMPTY in-checkout db is not 'the db in use' (#767)", () => {
  const RESET_CMD = `pnpm ${"db" + ":reset"}`;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kanban-guard-content-"));
    await mkdir(join(root, "packages", "server"), { recursive: true });
    await mkdir(join(root, "home", ".agentic-kanban"), { recursive: true });
    await writeFile(join(root, "home", ".agentic-kanban", "kanban.db"), Buffer.alloc(16_384, 1));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const env = () => ({
    ...checkoutEnv(root),
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
  });

  const localDb = () => join(root, "packages", "server", "kanban.db");
  const homeBackups = () => readdir(join(root, "home", ".agentic-kanban", ".db-backups"));
  const localBackups = () => readdir(join(root, "packages", "server", ".db-backups"));

  /** A real SQLite file over the #165 floor, with `rows` rows in `projects`. */
  function writeLocalSqlite(rows: number): void {
    const db = new DatabaseSync(localDb());
    try {
      // page_size 16384 puts the file at 32768 bytes, so the size floor never decides here.
      db.exec("pragma page_size=16384; vacuum; create table projects (id text primary key)");
      for (let i = 0; i < rows; i++) db.exec(`insert into projects (id) values ('p${i}')`);
    } finally {
      db.close();
    }
  }

  it("a schema-only (migrated-but-empty) local db resolves to the home fallback", async () => {
    writeLocalSqlite(0);
    expect(statSync(localDb()).size).toBeGreaterThanOrEqual(12_288);

    const result = runGuard(RESET_CMD, env(), root);

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("resolved via home-fallback");
    expect(result.reason).toContain(join(root, "home", ".agentic-kanban", "kanban.db"));
    expect((await homeBackups()).some((f) => /^kanban-.*\.db$/.test(f))).toBe(true);
    // The empty shadow must not be the thing that got "protected".
    await expect(localBackups()).rejects.toThrow();
  });

  it("distinguishes 'no board content' from 'below the floor' in the block message", async () => {
    writeLocalSqlite(0);

    const result = runGuard(RESET_CMD, env(), root);

    expect(result.reason).toContain(localDb());
    expect(result.reason).toContain("is NOT the database in use");
    expect(result.reason).toContain("IS a real database, but holds no board content");
    expect(result.reason).toContain("#663");
    // The two diagnoses lead to different remedies, so the floor's wording must NOT appear.
    expect(result.reason).not.toContain("below the 12288-byte");
  });

  it("a local db WITH a projects row is still adopted (the normal dev case)", async () => {
    writeLocalSqlite(1);

    const result = runGuard(RESET_CMD, env(), root);

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("resolved via local-checkout");
    expect(result.reason).not.toContain("is NOT the database in use");
    expect((await localBackups()).some((f) => /^kanban-.*\.db$/.test(f))).toBe(true);
  });

  it("an unreadable/corrupt real-sized local db fails OPEN and stays adopted", async () => {
    // A briefly-locked healthy dev DB must never be demoted to the home fallback on a failed
    // probe — the guard would then back up the wrong file for a reason unrelated to which
    // database is real. Non-SQLite bytes are the probe-fails case that is trivially reproducible.
    await writeFile(localDb(), Buffer.alloc(16_384, 7));

    const result = runGuard(RESET_CMD, env(), root);

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("resolved via local-checkout");
    expect(result.reason).not.toContain("holds no board content");
    expect((await localBackups()).some((f) => /^kanban-.*\.db$/.test(f))).toBe(true);
  });

  it("an explicit KANBAN_DB_URL wins over any local candidate", async () => {
    // A perfectly good local candidate — it must lose to the documented pin, exactly as
    // db-path.ts's precedence has it (rule 1 beats rule 3).
    writeLocalSqlite(1);
    const pinned = join(root, "pinned", "kanban.db");
    await mkdir(join(root, "pinned"), { recursive: true });
    await writeFile(pinned, Buffer.alloc(16_384, 1));

    const result = runGuard(RESET_CMD, { ...env(), KANBAN_DB_URL: `file:${pinned.replace(/\\/g, "/")}` }, root);

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("resolved via DB_URL");
    expect(result.reason).toContain(pinned);
    expect((await readdir(join(root, "pinned", ".db-backups"))).some((f) => /^kanban-.*\.db$/.test(f))).toBe(true);
    await expect(localBackups()).rejects.toThrow();
  });

  it("the legacy DB_URL is still honoured when KANBAN_DB_URL is unset", async () => {
    const pinned = join(root, "legacy", "kanban.db");
    await mkdir(join(root, "legacy"), { recursive: true });
    await writeFile(pinned, Buffer.alloc(16_384, 1));

    const result = runGuard(RESET_CMD, { ...env(), DB_URL: `file:${pinned.replace(/\\/g, "/")}` }, root);

    expect(result.reason).toContain(pinned);
  });
});

/**
 * #420 — two false positives, both reproduced live (2026-08-11/12).
 *
 * Guard precision matters double here: every false positive trains agents to reflexively split or
 * obfuscate commands, which erodes exactly the scrutiny the guard depends on. Both workarounds
 * people had learned (split the chain into two Bash calls; write the payload to a file and pass
 * it by reference) are pure evasion practice.
 */
describe("validate-command-safety — false positives from DATA that merely names the db (#420)", () => {
  it("allows a read-only file: URL query chained with a CLI subcommand named 'move'", () => {
    // Shape 1: the SELECT supplied the db reference and the word "move" in `issue move` supplied
    // the "verb". Each half ran fine alone; only the chain tripped it.
    const command = [
      `node -e "const{createClient}=require('@libsql/client');`,
      `const c=createClient({url:'file:C:/Users/x/.agentic-kanban/kanban.db'});`,
      `c.execute('select count(*) from issues')"`,
      "&& pnpm cli -- issue move 4f1c Done",
    ].join(" ");
    // This fixture contains `pnpm cli --`, which a SEPARATE and entirely correct rule
    // (`usesWorktreeCli`) refuses from any path under `.worktrees/`. So `blocked === false`
    // held ONLY in the main checkout — and every pre-merge verify gate runs in a worktree,
    // which meant this single test failed in EVERY gate and withheld EVERY merge, while
    // passing for anyone who ran it by hand. (Measured: identical guard bytes, opposite
    // verdicts, main checkout vs `.worktrees/agentic-kanban/ak-478`.)
    //
    // The subject here is the #420 db-name/verb false positive, not worktree CLI policy, so
    // assert that specifically: in a worktree the command may be refused, but ONLY by the
    // CLI rule — never by the db-safety rule this case exists to pin.
    const result = runGuard(command);
    if (RUNNING_IN_WORKTREE) {
      expect(result.reason).toMatch(/pnpm cli/i);
    } else {
      expect(result.blocked).toBe(false);
    }
  });

  it("allows an INLINE curl payload whose prose names the db beside a destructive word", () => {
    // Shape 2: a bug report ABOUT this guard was blocked by its own subject matter.
    const command = `curl -s -X POST http://localhost:3001/api/issues `
      + `-d '{"title":"guard false positive","description":"rm of kanban.db is refused even when reading"}'`;
    expect(runGuard(command).blocked).toBe(false);
  });

  it("still blocks a REAL destructive path, so the stripping is not a bypass", () => {
    // A `file:` URL cannot be deleted; a plain path can. This is the line the fix walks.
    expect(runGuard(`rm -f D:/live/packages/server/kanban.db`).blocked).toBe(true);
  });

  it("still blocks when the payload flag names a FILE rather than inline data", () => {
    // `-d @x` is a path on disk — a filesystem argument, so it stays visible to the guard.
    expect(runGuard(`rm -f D:/live/kanban.db && curl -d @payload.json http://x/`).blocked).toBe(true);
  });

  it("blocks an fs call inside node -e against a plain db path", () => {
    // Found while fixing the above: `\bunlink\b` never matched `unlinkSync`, so this was ALLOWED.
    // A destructive call is as destructive inside `node -e` as it is in the shell.
    const command = `node -e "require('fs').unlinkSync('D:/live/packages/server/kanban.db')"`;
    expect(runGuard(command).blocked).toBe(true);
  });

  it("does not treat the mere WORD unlink in prose as a verb", () => {
    // The call parenthesis is what makes it a verb — the same discipline the stripping preserves.
    const command = `curl -s -X POST http://x/ -d '{"body":"we should unlink the stale kanban.db stub"}'`;
    expect(runGuard(command).blocked).toBe(false);
  });
});

/**
 * #420, third instance — found while COMMITTING the first two.
 *
 * The reset check ran on the RAW command string, before any of the data-stripping every other
 * check does. So a commit message inside a heredoc that merely said "verified db:reset still
 * blocks" blocked its own commit. A real reset invocation is never inside a heredoc, a payload or
 * a URL, so stripping first costs the check nothing.
 */
describe("validate-command-safety — the reset check reads data-stripped text too (#420)", () => {
  const RESET = "db" + ":reset";

  it("allows a heredoc commit message that merely NAMES the reset command", () => {
    const command = `cat > msg.txt <<'MSGEOF'\nverified ${RESET} still blocks\nMSGEOF\ngit commit -F msg.txt -- x.js`;
    expect(runGuard(command).blocked).toBe(false);
  });

  it("still blocks the real reset invocation", () => {
    expect(runGuard(`pnpm ${RESET}`).blocked).toBe(true);
  });

  it("still blocks the reset even when a heredoc is also present", () => {
    const command = `cat > note.txt <<'MSGEOF'\nunrelated prose\nMSGEOF\npnpm ${RESET}`;
    expect(runGuard(command).blocked).toBe(true);
  });
});

/**
 * #598 item 7 — the two CLAUDE.md hard constraints the hook enforces but nothing tested.
 *
 * The suite had 34 black-box cases and none for either rule, so both could have been
 * weakened or regex-broken silently. Every dangerous literal is ASSEMBLED from pieces
 * rather than written out: the guard reads this file's own command text when the suite is
 * edited through a shell, and a spelled-out kill would block the very edit that adds the
 * case. (`RESET` above exists for the same reason.)
 */
describe("validate-command-safety — broad node kills and read-only PS vars (#598)", () => {
  const NODE = "no" + "de";
  const STOP = "Stop-" + "Process";

  it(`blocks a whole-node kill by name (${STOP} -Name …)`, () => {
    expect(runGuard(`${STOP} -Name ${NODE} -Force`).blocked).toBe(true);
  });

  it("blocks the unix spellings too (pkill / killall)", () => {
    expect(runGuard(`pk` + `ill -f ${NODE}`).blocked).toBe(true);
    expect(runGuard(`kill` + `all ${NODE}`).blocked).toBe(true);
  });

  it("still ALLOWS a port-scoped kill — the sanctioned dev-server recipe", () => {
    // The rule is "never ALL node", not "never kill anything": the dev-server skill's
    // Stop-PortOwner recipe must keep working, or the guard just gets routed around.
    //
    // #674 — the port here must NOT be 3001. `isMainBoardPortKill` blocks a kill scoped to
    // the BOARD's port, but only when the guard runs from a worktree
    // (`if (!isWorktreeProjectDir()) return false`). runGuard spawns with cwd = REPO_ROOT,
    // which IS a worktree during a pre-merge gate run — so a 3001-scoped kill was correctly
    // blocked there while passing in the main checkout, and this case failed in EVERY gate
    // run on this board by construction. The guard is right; the port choice was wrong. A
    // worktree-style port asserts what this case actually means without colliding with the
    // board-port rule.
    const command =
      `$owner = (Get-NetTCPConnection -LocalPort 3672 -State Listen).OwningProcess; ` +
      `${STOP} -Id $owner -Force`;
    expect(runGuard(command).blocked).toBe(false);
  });

  it("blocks assigning a read-only PowerShell automatic variable", () => {
    // Assigning $pid throws AND keeps the built-in, so a REST call using it hits the
    // wrong id — the failure this rule exists to prevent is a silent wrong write.
    expect(runGuard(`$p` + `id = "abc123"; curl http://127.0.0.1:3001/api/issues/$p` + `id`).blocked).toBe(true);
  });

  it("does NOT block a distinct name that merely starts with a reserved one", () => {
    // `$pidx`/`$projectId` are valid, distinct variables; a `\b`-less regex would eat them.
    expect(runGuard(`$p` + `idx = 42; echo $p` + `idx`).blocked).toBe(false);
    expect(runGuard(`$projectId = "d1c5"; echo $projectId`).blocked).toBe(false);
  });
});
