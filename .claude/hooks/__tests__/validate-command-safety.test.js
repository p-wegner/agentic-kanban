#!/usr/bin/env node
// #1001: a fork-child reviewer, unable to reach the mark_ready_for_merge MCP
// tool, fell back to a direct sqlite write against kanban.db. This guards the
// hook's detection of direct-SQL-write commands (distinct from the existing
// file-erasure/overwrite detection it already covers).
//
// Standalone Node assertion script — the hooks directory has no vitest/package.json
// of its own (confirmed: no existing test convention for these hooks). Run directly:
//   node .claude/hooks/__tests__/validate-command-safety.test.js
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");

const HOOK_PATH = path.join(__dirname, "..", "validate-command-safety.js");

function runHook(command, env = {}, cwd = process.cwd()) {
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({ command, cwd }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
    });
    return { blocked: false, stdout };
  } catch (err) {
    return { blocked: true, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/**
 * A throwaway checkout holding a REAL-sized `packages/server/kanban.db`.
 *
 * A case asserting "a destructive shape aimed at the database blocks" must supply the database
 * itself: the repo-relative path means "whatever file sits there", and on a machine where that
 * is a stray sub-12KB stub the #406 carve-out correctly ALLOWS its removal — which turned the
 * file-erasure case below red here while it was green wherever it was written.
 */
function withRealDbCheckout(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-hook-checkout-"));
  try {
    fs.mkdirSync(path.join(root, "packages", "server"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", "server", "kanban.db"), Buffer.alloc(16_384, 1));
    return run(root, { CLAUDE_PROJECT_DIR: root, KANBAN_MAIN_CHECKOUT: root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const cases = [
  {
    name: "blocks a sqlite3 CLI UPDATE against kanban.db",
    run: () => {
      const r = runHook(`sqlite3 packages/server/kanban.db "UPDATE workspaces SET ready_for_merge=1 WHERE id='abc'"`);
      assert.equal(r.blocked, true, "expected command to be blocked");
      assert.match(r.stdout, /"decision"\s*:\s*"block"/);
      assert.match(r.stdout.toLowerCase(), /mcp/);
    },
  },
  {
    name: "blocks a node one-liner using better-sqlite3 to write ready_for_merge",
    run: () => {
      const r = runHook(
        `node -e "const db=require('better-sqlite3')('packages/server/kanban.db'); db.prepare('UPDATE workspaces SET ready_for_merge=1').run();"`,
      );
      assert.equal(r.blocked, true, "expected command to be blocked");
    },
  },
  {
    name: "is NOT bypassable via ALLOW_DB_DESTROY (that override is for resets, not SQL-write routing)",
    run: () => {
      const r = runHook(`sqlite3 packages/server/kanban.db "UPDATE workspaces SET ready_for_merge=1"`, {
        ALLOW_DB_DESTROY: "1",
      });
      assert.equal(r.blocked, true, "expected command to still be blocked despite ALLOW_DB_DESTROY=1");
    },
  },
  {
    name: "does not block a read-only sqlite3 query against kanban.db",
    run: () => {
      const r = runHook(`sqlite3 packages/server/kanban.db "SELECT * FROM workspaces LIMIT 1"`);
      assert.equal(r.blocked, false, "expected read-only query to pass through");
    },
  },
  {
    name: "does not block an unrelated better-sqlite3 write to a non-kanban db",
    run: () => {
      const r = runHook(`node -e "require('better-sqlite3')('/tmp/other.db').prepare('UPDATE foo SET x=1').run();"`);
      assert.equal(r.blocked, false, "expected non-kanban db write to pass through");
    },
  },
  {
    name: "still blocks the pre-existing file-erasure case (rm kanban.db)",
    run: () => {
      withRealDbCheckout((root, env) => {
        const r = runHook(`rm packages/server/kanban.db`, env, root);
        assert.equal(r.blocked, true, "expected file-erasure case to remain blocked");
      });
    },
  },
  {
    // #758: the local-checkout probe was a bare `existsSync`, so a 0-byte stray
    // `packages/server/kanban.db` made the hook name that STUB as "the db in use" and
    // `backupDatabase()` copy 0 bytes — while the real database sat in the home dir,
    // unprotected, behind a message that honestly reported "NO BACKUP EXISTS". The CLI
    // resolver has applied the #165 size floor all along, so the two disagreed about
    // which file the board uses. The reset shape is assembled from pieces because the
    // LIVE guard reads this file's own text whenever it is edited through a shell.
    name: "a sub-floor in-checkout db is not the db in use — the real home db gets the backup (#758)",
    run: () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-hook-stub-local-"));
      try {
        fs.mkdirSync(path.join(root, "packages", "server"), { recursive: true });
        fs.writeFileSync(path.join(root, "packages", "server", "kanban.db"), "");
        const home = path.join(root, "home");
        fs.mkdirSync(path.join(home, ".agentic-kanban"), { recursive: true });
        const realDb = path.join(home, ".agentic-kanban", "kanban.db");
        fs.writeFileSync(realDb, Buffer.alloc(16_384, 1));

        // A reset blocks on its own shape, so this reaches the block MESSAGE without
        // depending on the #406 stub carve-out (which would ALLOW removing the stub).
        const r = runHook(`pnpm ${"db" + ":reset"}`, {
          CLAUDE_PROJECT_DIR: root,
          KANBAN_MAIN_CHECKOUT: root,
          HOME: home,
          USERPROFILE: home,
          KANBAN_DB_URL: "",
          DB_URL: "",
          AGENTIC_KANBAN_DIR: "",
        }, root);

        assert.equal(r.blocked, true, "expected the reset to stay blocked");
        assert.ok(
          fs.existsSync(path.join(home, ".agentic-kanban", ".db-backups")),
          "expected the REAL home database to be the thing backed up",
        );
        assert.equal(
          fs.existsSync(path.join(root, "packages", "server", ".db-backups")),
          false,
          "the sub-floor stub must not be treated as the database in use",
        );
        // The block message must name the file the backup actually covered — that claim
        // is the one an agent can check against disk.
        assert.ok(
          r.stdout.includes(JSON.stringify(realDb).slice(1, -1)),
          "block message must name the db the backup covered",
        );
        assert.match(r.stdout, /is NOT the database in use/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    // The floor must not swallow the normal dev case: a real in-checkout database is
    // still adopted, and is what gets backed up.
    name: "a real-sized in-checkout db is still adopted as the db in use (#758)",
    run: () => {
      withRealDbCheckout((root, env) => {
        const home = path.join(root, "home");
        fs.mkdirSync(path.join(home, ".agentic-kanban"), { recursive: true });
        fs.writeFileSync(path.join(home, ".agentic-kanban", "kanban.db"), Buffer.alloc(16_384, 2));

        const r = runHook(`pnpm ${"db" + ":reset"}`, { ...env, HOME: home, USERPROFILE: home, KANBAN_DB_URL: "", DB_URL: "", AGENTIC_KANBAN_DIR: "" }, root);

        assert.equal(r.blocked, true, "expected the reset to stay blocked");
        assert.ok(
          fs.existsSync(path.join(root, "packages", "server", ".db-backups")),
          "expected the in-checkout database to be backed up",
        );
        assert.equal(
          fs.existsSync(path.join(home, ".agentic-kanban", ".db-backups")),
          false,
          "the home fallback must not be reached while a real in-checkout db exists",
        );
      });
    },
  },
  {
    // #767: one notch narrower than #758. A leftover in-checkout DB that has been fully
    // MIGRATED but holds zero rows is ~850 KB, so the #165 size floor waves it through — only
    // CONTENT tells it apart from the real board, which is why the CLI resolver opens the DB
    // read-only (`sqliteHasBoardContent`, #663) and why this hook now does too.
    name: "a real-but-EMPTY in-checkout db is not the db in use (#767)",
    run: () => {
      const { DatabaseSync } = require("node:sqlite");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-hook-empty-local-"));
      try {
        fs.mkdirSync(path.join(root, "packages", "server"), { recursive: true });
        const local = path.join(root, "packages", "server", "kanban.db");
        // page_size 16384 puts the file at 32768 bytes, well clear of the size floor, so
        // content is the only thing that can decide this case.
        const db = new DatabaseSync(local);
        db.exec("pragma page_size=16384; vacuum; create table projects (id text primary key)");
        db.close();
        assert.ok(fs.statSync(local).size >= 12_288, "fixture must clear the #165 size floor");

        const home = path.join(root, "home");
        fs.mkdirSync(path.join(home, ".agentic-kanban"), { recursive: true });
        fs.writeFileSync(path.join(home, ".agentic-kanban", "kanban.db"), Buffer.alloc(16_384, 1));

        const r = runHook(`pnpm ${"db" + ":reset"}`, {
          CLAUDE_PROJECT_DIR: root,
          KANBAN_MAIN_CHECKOUT: root,
          HOME: home,
          USERPROFILE: home,
          KANBAN_DB_URL: "",
          DB_URL: "",
          AGENTIC_KANBAN_DIR: "",
        }, root);

        assert.equal(r.blocked, true, "expected the reset to stay blocked");
        assert.ok(
          fs.existsSync(path.join(home, ".agentic-kanban", ".db-backups")),
          "expected the REAL home database to be the thing backed up",
        );
        assert.equal(
          fs.existsSync(path.join(root, "packages", "server", ".db-backups")),
          false,
          "a migrated-but-empty local db must not be treated as the database in use",
        );
        // The two rejection grounds lead to different remedies, so the message must say WHICH.
        assert.match(r.stdout, /IS a real database, but holds no board content/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    // #767: `KANBAN_DB_URL` is the canonical name db-path.ts prefers; the hook read only the
    // pre-rename `DB_URL`, so pinning the database the DOCUMENTED way was ignored and the
    // guard's backup covered whatever its own candidate search landed on instead.
    name: "an explicit KANBAN_DB_URL wins over a real in-checkout candidate (#767)",
    run: () => {
      withRealDbCheckout((root, env) => {
        const pinned = path.join(root, "pinned", "kanban.db");
        fs.mkdirSync(path.join(root, "pinned"), { recursive: true });
        fs.writeFileSync(pinned, Buffer.alloc(16_384, 1));

        const r = runHook(`pnpm ${"db" + ":reset"}`, {
          ...env,
          KANBAN_DB_URL: `file:${pinned.replace(/\\/g, "/")}`,
          DB_URL: "",
          AGENTIC_KANBAN_DIR: "",
        }, root);

        assert.equal(r.blocked, true, "expected the reset to stay blocked");
        assert.ok(
          fs.existsSync(path.join(root, "pinned", ".db-backups")),
          "expected the KANBAN_DB_URL-pinned database to be the thing backed up",
        );
        assert.equal(
          fs.existsSync(path.join(root, "packages", "server", ".db-backups")),
          false,
          "an explicit env pin must outrank the in-checkout candidate search",
        );
        assert.match(r.stdout, /resolved via DB_URL/);
      });
    },
  },
];

let failed = 0;
for (const { name, run } of cases) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(`  ${err.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${cases.length} case(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} case(s) passed.`);
