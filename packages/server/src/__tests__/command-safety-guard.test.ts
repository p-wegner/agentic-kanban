import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The dev checkout's LIVE hook.
const HOOK = join(__dirname, "../../../../.claude/hooks/validate-command-safety.js");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  blocked: boolean;
  reason: string;
}

function runGuard(command: string, env: Record<string, string> = {}): RunResult {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, ALLOW_DB_DESTROY: "", DB_URL: "", AGENTIC_KANBAN_DIR: "", ...env },
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

  it("still blocks when the db name appears OUTSIDE the heredoc as a real argument", () => {
    const command = ["rm packages/server/kanban.db <<'EOF'", "unrelated body", "EOF"].join("\n");
    expect(runGuard(command).blocked).toBe(true);
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
  for (const command of [
    "rm packages/server/kanban.db",
    "rm -rf /mnt/c/projects/andrena/agentic-kanban/packages/server/kanban.db",
    "Remove-Item ~/.agentic-kanban/kanban.db",
    "Move-Item packages/server/kanban.db C:/tmp/",
    "pnpm db:reset",
    "rm *.db",
  ]) {
    it(`blocks: ${command}`, () => {
      expect(runGuard(command).blocked).toBe(true);
    });
  }
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
    await writeFile(db, "real-database-content");
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
    await writeFile(join(home, ".agentic-kanban", "kanban.db"), "fallback-db-content");

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

  it("says explicitly that NO backup exists when the db is absent, rather than implying one ran", () => {
    const result = runGuard("rm packages/server/kanban.db", {
      AGENTIC_KANBAN_DIR: join(dataDir, "empty"),
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("NO BACKUP EXISTS");
    expect(result.reason).toContain("no database file exists at");
    // The old message claimed "the db was missing or empty" with no path — the
    // whole point of the fix is that the resolved location is named.
    expect(result.reason).toContain("kanban.db");
  });
});
