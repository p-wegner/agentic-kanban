#!/usr/bin/env node
// Standalone entry for the `agentic-kanban-worker` binary.
//
// WHY THIS EXISTS. The main `agentic-kanban` CLI registers every board command
// at module load, and some of those modules import the database layer — so
// `agentic-kanban worker start` on a machine that has no board still resolves a
// DB location and creates an empty kanban.db, and pays the load cost of drizzle
// and the rest of the server graph. A worker needs none of it: it speaks HTTP
// and WebSocket to the board and spawns a local agent process.
//
// This entry therefore builds its OWN commander program with only the worker
// subcommands attached, and imports nothing else. Keep it that way: anything
// added here (or to the modules it reaches) that pulls in `db/index.js` or the
// board services silently re-introduces exactly what this file exists to avoid.
// `worker-cli-isolation.test.ts` fails the build if that happens.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { registerWorkerSubcommands } from "../cli/commands/worker.js";

// `--version` MUST describe the artifact that is actually installed. It was
// hardcoded to "0.0.1", which is worse than useless on a worker machine: builds
// are handed over as sha-stamped tarballs (scripts/pack-worker.mjs), so the one
// question `--version` exists to answer is "which build is this?" — and a fixed
// string answers it with a plausible number that carries no information. Read it
// from our own package.json instead, walking up because the bundled entry
// (dist/worker.js) and the tsc output (dist/worker/worker-cli.js) sit at
// different depths. Fall back to "unknown" rather than to any number: a wrong
// version is the failure mode being fixed here.
function resolveVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let up = 0; up < 5; up++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "agentic-kanban" && pkg.version) return pkg.version;
      } catch {
        // no package.json at this level — keep walking
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return "unknown";
}

/**
 * #754 — a daemon that dies takes every agent on this machine with it.
 *
 * There was no top-level handler anywhere in the worker entry, so ANY unhandled error —
 * an EPIPE on an agent's stdin being the concrete case that motivated this — terminated
 * the process and orphaned every running session. A long-running process on someone
 * else's machine has to prefer "log it and keep going" to "exit clean": whatever is
 * broken, the other sessions on this worker are not, and their results are still owed to
 * the board.
 *
 * Deliberately NOT a silent swallow: the stack is printed in full, because the failure
 * this protects against is also the failure someone will have to diagnose from a log tail.
 */
function installProcessGuards(): void {
  process.on("uncaughtException", (err) => {
    console.error("[worker] uncaught exception (daemon staying up — running agents keep their sessions):", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[worker] unhandled rejection (daemon staying up):", reason);
  });
}

installProcessGuards();

const program = new Command();

program
  .name("agentic-kanban-worker")
  .description(
    "Run this machine as a compute worker for an agentic-kanban board.\n\n" +
      "The board schedules agent sessions onto connected workers: this machine clones the repo from\n" +
      "the board over git-over-HTTP, runs the agent in its own checkout, and pushes the result back.\n" +
      "No board checkout and no board database are required.\n\n" +
      "Start here:  agentic-kanban-worker instructions --board <board-url>",
  )
  .version(resolveVersion());

registerWorkerSubcommands(program);

program.addHelpText(
  "after",
  `
Examples:
  $ agentic-kanban-worker instructions --board http://board:3001   # full setup runbook
  $ agentic-kanban-worker start --board http://board:3001 --token <pairing-token>
  $ agentic-kanban-worker list --board http://board:3001
`,
);

program.parse();
