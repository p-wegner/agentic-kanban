import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolveMcpServerInvocation } from "./agent-provider/helpers.js";

/**
 * The board-side owner of the HTTP MCP listener that containerized builders dial (#136).
 *
 * A containerized builder cannot use the normal stdio MCP config: it names a host
 * command that does not exist inside the container, and the DB is opened through a
 * natively-compiled Windows better-sqlite3 binding, so bind-mounting the board repo
 * would not help either. The listener is therefore a real process serving the same
 * tool registrations over Streamable HTTP, reached at `host.docker.internal`.
 *
 * ONE listener per board process, started lazily on the first containerized launch
 * and reused thereafter — containerized builders are opt-in and off by default, so a
 * board that never uses them never pays for this.
 *
 * The port is OS-assigned (`--http` with no number) and read back from the child's
 * stderr. Guessing a port in the 30000-60000 range on Windows flakes with EACCES
 * against reserved ranges, so never guess.
 */

export interface McpHttpBridge {
  port: number;
  token: string;
}

let bridge: McpHttpBridge | null = null;
let child: ChildProcess | null = null;
let starting: Promise<McpHttpBridge | null> | null = null;

/** Bounded wait for the child to announce its port before we give up on it. */
const STARTUP_TIMEOUT_MS = 30_000;

/**
 * Ensure the HTTP MCP listener is running and return how to reach it.
 *
 * Best-effort, matching the rest of containerized provisioning: on failure this
 * resolves null and the caller leaves the builder without board tools rather than
 * failing the workspace.
 */
export async function ensureMcpHttpBridge(): Promise<McpHttpBridge | null> {
  if (bridge && child && !child.killed) return bridge;
  if (starting) return starting;

  starting = startBridge().finally(() => {
    starting = null;
  });
  return starting;
}

async function startBridge(): Promise<McpHttpBridge | null> {
  // 256 bits, hex. Regenerated per board start, so a token that leaks out of a
  // container is useless after a restart.
  const token = randomBytes(32).toString("hex");
  const invocation = resolveMcpServerInvocation();

  const proc = spawn(invocation.command, [...invocation.args, "--http"], {
    env: {
      ...process.env,
      KANBAN_MCP_TOKEN: token,
      // Pin the child to the SAME database this server uses. Without it the child
      // re-runs data-dir resolution under a different cwd and can land on
      // ~/.agentic-kanban — a DIFFERENT board, so the builder would read and mutate
      // the wrong one.
      ...(process.env.DB_URL ? { DB_URL: process.env.DB_URL } : {}),
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  const port = await new Promise<number | null>((resolvePort) => {
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePort(value);
    };

    const timer = setTimeout(() => {
      console.warn("[mcp-http] listener did not report a port in time — builders will lack board tools");
      finish(null);
    }, STARTUP_TIMEOUT_MS);

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const match = /MCP_HTTP_PORT=(\d+)/.exec(text);
      if (match) finish(Number(match[1]));
      // Surface the child's diagnostics; it never writes to stdout in http mode.
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) console.log(`[mcp-http] ${line.trim()}`);
      }
    });
    proc.once("error", (err) => {
      console.warn("[mcp-http] failed to spawn listener:", err);
      finish(null);
    });
    proc.once("exit", (code) => {
      console.warn(`[mcp-http] listener exited (code ${code})`);
      bridge = null;
      child = null;
      finish(null);
    });
  });

  if (port === null) {
    proc.kill();
    return null;
  }

  child = proc;
  bridge = { port, token };
  console.log(`[mcp-http] board MCP reachable at :${port} for containerized builders`);
  return bridge;
}

/** Stop the listener. Called on shutdown; safe to call when nothing is running. */
export function stopMcpHttpBridge(): void {
  if (child && !child.killed) child.kill();
  child = null;
  bridge = null;
}

/** Test seam — drops memoized state without touching a real process. */
export function __resetMcpHttpBridgeForTests(): void {
  child = null;
  bridge = null;
  starting = null;
}
