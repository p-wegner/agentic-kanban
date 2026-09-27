import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { resolveBoardServerPort } from "@agentic-kanban/shared/lib/board-server-url";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Where a CLI issue WRITE goes: through the running board server, or straight into the DB.
 *
 * A write the CLI makes directly in the database is invisible to the server's broadcast
 * bus, so an open board UI shows none of it until a manual reload (measured 2026-09-27:
 * seven `issue create` calls, zero cards on the open board). When a board server answers
 * on the resolved port AND serves the same database file this CLI resolved, the write goes
 * through its REST API, which broadcasts. Otherwise the caller keeps the direct-DB path and
 * prints {@link directWriteNotice} once.
 *
 * The database-identity check is the safety half: a CLI pointed at a temp or dev DB
 * (`DB_URL`, a test harness, a worktree) must never write into whatever board happens to
 * listen on 3001.
 *
 * ONE probe (`GET /api/health`, short timeout), never a polling loop.
 * `KANBAN_CLI_WRITE_TRANSPORT=direct` skips the probe entirely (the spawn-based CLI test
 * harness sets it, so no test ever talks to a board that happens to be running).
 *
 * Transport is `node:http` with `agent: false` + `Connection: close`, NOT `fetch`: the CLI
 * ends with `process.exit`, and on Windows exiting while undici's pooled keep-alive socket
 * is still open aborts node with the libuv `UV_HANDLE_CLOSING` assertion (exit 0xC0000409),
 * so a successful write reported a crash code. Measured on the first cut of this module.
 */
export type IssueWriteTransport =
  | { mode: "server"; baseUrl: string }
  | { mode: "direct"; reason: string };

export interface HttpAnswer { status: number; text: string }
export type HttpLike = (
  url: string,
  init: { method: string; body?: string; timeoutMs?: number },
) => Promise<HttpAnswer>;

/** One request, no connection reuse, so no socket outlives it. */
export const plainHttp: HttpLike = (url, init) =>
  new Promise((resolveAnswer, reject) => {
    const req = httpRequest(url, {
      method: init.method,
      agent: false,
      headers: {
        Connection: "close",
        ...(init.body !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(init.body) } : {}),
      },
      timeout: init.timeoutMs,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { text += c; });
      res.on("end", () => resolveAnswer({ status: res.statusCode ?? 0, text }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timed out after ${init.timeoutMs} ms`)));
    req.on("error", reject);
    req.end(init.body);
  });

export interface ResolveTransportOptions {
  /** Explicit port; otherwise the shared ladder ($KANBAN_BOARD_SERVER_PORT … or 3001). */
  port?: string | number;
  /** The DB file this CLI resolved. Defaults to `DB_LOCATION.path`. */
  cliDbPath?: string | null;
  http?: HttpLike;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

const PROBE_TIMEOUT_MS = 1500;

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const na = resolve(a);
  const nb = resolve(b);
  return platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

async function defaultCliDbPath(): Promise<string | null> {
  const { DB_LOCATION } = await import("../db/data-dir.js");
  return DB_LOCATION.path;
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

export async function resolveIssueWriteTransport(opts: ResolveTransportOptions = {}): Promise<IssueWriteTransport> {
  const env = opts.env ?? process.env;
  if (env.KANBAN_CLI_WRITE_TRANSPORT === "direct") {
    return { mode: "direct", reason: "KANBAN_CLI_WRITE_TRANSPORT=direct" };
  }
  const port = resolveBoardServerPort(opts.port, env);
  const baseUrl = `http://127.0.0.1:${port}`;
  const where = `127.0.0.1:${port}`;

  let answer: HttpAnswer;
  try {
    answer = await (opts.http ?? plainHttp)(`${baseUrl}/api/health`, { method: "GET", timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS });
  } catch {
    return { mode: "direct", reason: `no board server answered on ${where}` };
  }
  if (answer.status < 200 || answer.status >= 300) {
    return { mode: "direct", reason: `the board server on ${where} reported unhealthy (HTTP ${answer.status})` };
  }
  const body = parseJson(answer.text) as { db?: { path?: string | null } } | null;
  const serverDbPath = (body && typeof body === "object" ? body.db?.path : null) ?? null;
  const cliDbPath = opts.cliDbPath !== undefined ? opts.cliDbPath : await defaultCliDbPath();
  if (!serverDbPath || !cliDbPath) {
    return { mode: "direct", reason: `the board server on ${where} could not be matched to this CLI's database` };
  }
  if (!samePath(serverDbPath, cliDbPath, opts.platform ?? process.platform)) {
    return {
      mode: "direct",
      reason: `the board server on ${where} serves a different database (${serverDbPath}) than this CLI (${cliDbPath})`,
    };
  }
  return { mode: "server", baseUrl };
}

/** The one stderr line a direct-DB write prints (stderr, so `--json` stdout stays clean). */
export function directWriteNotice(reason: string): string {
  return `Note: ${reason}; wrote to the database directly. An open board UI will not show this change until it is reloaded.`;
}

/**
 * One REST write against the board server. Throws with the server's own `error` text on a
 * non-2xx answer, so a refused write (e.g. the AK-535 terminal-move guard's 409) reads the
 * same as the direct path's message. Never retried and never falls back to the DB: a write
 * that may have landed must not be applied twice.
 */
export async function boardServerWrite<T>(
  transport: { baseUrl: string },
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  http: HttpLike = plainHttp,
): Promise<T> {
  let answer: HttpAnswer;
  try {
    answer = await http(`${transport.baseUrl}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    throw new Error(`board server request ${method} ${path} failed: ${errorMessage(err)}`);
  }
  const data = parseJson(answer.text);
  if (answer.status < 200 || answer.status >= 300) {
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `HTTP ${answer.status}`;
    throw new Error(msg);
  }
  return data as T;
}
