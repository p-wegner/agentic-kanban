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
