// vitest globalSetup (#1528): pay the cold `node --import tsx` transpile of the MCP server ONCE,
// before any suite starts, instead of once per spawn-based suite inside a 120 s `beforeAll`.
//
// tsx persists its transpile cache on disk, so one throwaway start warms every later spawn in
// the run. On a disk-bound worker the cold compile alone exceeded the per-suite hook budget and
// turned the base sweep red; here it runs in globalSetup, which has no hook timeout, while the
// per-suite hook timeout stays a real hang guard. Best effort: a failed warm-up is logged and
// ignored — the suites then spawn cold exactly as before and report their own errors.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { startMcpServer, stopMcpServer } from "./server-process.js";

export default async function warmMcpServer(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ak-mcp-warm-"));
  let proc: ChildProcess | undefined;
  try {
    proc = await startMcpServer(join(dir, "warm.db"), { startupTimeoutMs: 600_000 });
  } catch (err) {
    console.warn(
      `[warm-mcp-server] warm-up failed, suites will spawn cold: ${(err as Error).message.split("\n")[0]}`,
    );
  } finally {
    await stopMcpServer(proc);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
