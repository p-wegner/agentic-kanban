#!/usr/bin/env node
// CLI entry — a thin router, deliberately importing nothing but commander.
//
// `db/index.ts` opens (and creates) the database as a module side effect, and the full
// command set (`./program.ts`) reaches it through static imports. `worker` commands are
// pure HTTP/WebSocket clients, so on a worker machine `agentic-kanban worker doctor`
// used to create an empty `~/.agentic-kanban/kanban.db` and print a `[db] opening` line
// (#1315). `worker` is therefore routed to a program carrying ONLY the worker commands
// BEFORE the full graph loads. Keep this file free of other static imports.

import { Command } from "commander";

// `pnpm cli -- <args>` forwards a literal "--"; look past it when routing (program.ts
// strips it again for the full CLI).
const firstArg = process.argv[2] === "--" ? process.argv[3] : process.argv[2];

if (firstArg === "worker") {
  if (process.argv[2] === "--") process.argv.splice(2, 1);
  const { registerWorkerCommand } = await import("./commands/worker.js");
  const program = new Command().name("agentic-kanban").usage("<command> [options]");
  registerWorkerCommand(program);
  program.parse();
} else {
  await import("./program.js");
}
