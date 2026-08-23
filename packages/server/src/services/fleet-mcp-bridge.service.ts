/**
 * The board MCP bridge a TRUE-REMOTE fleet worker's agent talks to (#769, follow-up to #749).
 *
 * WHAT #749 LEFT. A builder on a remote worker had NO `mcp__agentic-kanban__*` tools at all:
 * `remote-launch-spec.ts` strips `--mcp-config` because the board's config names a file in the
 * board's tmpdir describing a stdio server that would open the board's Windows-native sqlite
 * binding on a machine that does not have it. #749 made the shipped instructions HONEST about
 * that absence ("no board tools here"). This makes the absence UNNECESSARY.
 *
 * WHY THIS IS NOT A DECISION-012 VIOLATION. Decision 012 forbids shipping the board's AGENT
 * credentials — a provider login, `CLAUDE_CONFIG_DIR`, `~/.claude/settings_<profile>.json`. A
 * board-scoped, per-assignment CAPABILITY token is a different object, and the fleet already
 * ships one: `git.issueToken({ workerId, projectId, incomingRef })` (#247). This is the same
 * pattern, one listener over.
 *
 * SHAPE — a guarded proxy, not a second MCP server:
 *
 *   worker agent --(fleet port, per-assignment token)--> THIS route --(loopback, board token)-->
 *       the existing #136 MCP HTTP listener (`mcp-http-bridge.service.ts`)
 *
 * A proxy rather than a second registration because the #136 listener already serves the exact
 * tool surface, against the exact database, with `enableJsonResponse: true` — so every message
 * is plain JSON and can be INSPECTED. That inspection is the point: the #136 endpoint exposes
 * the FULL surface including `delete_issue` and `merge_workspace`, which is defensible for a
 * container the board provisioned on its own machine and is not defensible for another machine.
 * The proxy narrows it to {@link REMOTE_BOARD_TOOLS} and pins `create_issue` to the assignment's
 * project.
 *
 * MOUNTED ON THE FLEET LISTENER ONLY (`KANBAN_FLEET_PORT`), never the board API port — the board
 * API has no authentication whatsoever; that is why the second listener exists at all.
 *
 * TOKEN LIFETIME — deliberately IN-MEMORY, unlike the git token's `worker_git_tokens` rows (#775).
 * A git token must survive a board restart because the worker holds a live clone and a push
 * target across it. An MCP token must NOT: it authorises tool calls on behalf of one agent
 * session, the session map it speaks for is process-local and gone after a restart, and the
 * upstream #136 listener mints a FRESH board token per boot anyway — so a persisted MCP digest
 * could only ever outlive the thing it stands for. Reusing `worker_git_tokens` would also need a
 * purpose column (a migration) to keep git revocation from clearing MCP grants and vice versa.
 * Digests only either way: `createExpiringDigestStore` never keeps a clear token.
 */
import { Hono } from "hono";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createExpiringDigestStore, extractBearer } from "../lib/bearer-token.js";
import { ensureMcpHttpBridge } from "./mcp-http-bridge.service.js";
import { getWorkerRegistry } from "./worker-registry.service.js";

/** Path the bridge is mounted at on the fleet listener. */
export const FLEET_MCP_PATH = "/mcp";

/**
 * The file the worker writes into its checkout root, carrying the MCP config.
 *
 * A FILE, not `--mcp-config '<inline json>'`: the token would otherwise sit in the agent
 * process's argv, visible in any process listing on the worker — which is precisely why the git
 * token stopped travelling inside the clone URL (`composeGitUrl`). It rides the same channel the
 * ticket-context file already uses (`WorkerRepoTransport.contextFiles`, written by
 * `provisionWorkerCheckout` before the agent starts), so no worker-side change is needed.
 *
 * NOT `.mcp.json`: that name is Claude Code's auto-loaded project config and would apply to any
 * later session in that directory. This one is loaded only because the launch args name it.
 */
export const REMOTE_MCP_CONFIG_FILENAME = ".mcp-kanban.json";

/**
 * The tools a remote builder may call. Everything else is refused by the proxy.
 *
 * DELIBERATELY NOT the four names #769 asked for: there is no `add_comment` tool on this board
 * (the registry in `packages/mcp-server/src/index.ts` has `create_diff_comment`, which needs a
 * workspace plus a file and line, and `update_issue`, which can also move status). `list_issues`
 * takes its place — a builder about to file a finding needs to see whether it is already on the
 * board. Progress reflection stays where #749 put it: the session's own output, which the board
 * reads.
 *
 * What is kept OUT is the point: no `merge_workspace`, `mark_ready_for_merge` or
 * `close_workspace` (the merge gate is the board's decision, not a builder's), no
 * `set_preference` (a worker must not be able to retune the project that dispatched it), no
 * `delete_*`, no `start_workspace`/`relaunch_workspace` (a worker able to start work is a way to
 * spend the operator's quota), and no session/transcript readers.
 */
export const REMOTE_BOARD_TOOLS: readonly string[] = [
  "get_issue",
  "list_issues",
  "create_issue",
  "get_board_status",
];

/** How long a per-assignment token lives. Matches `DEFAULT_GIT_TOKEN_TTL_MS`: same assignment. */
export const DEFAULT_FLEET_MCP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface FleetMcpScope {
  /** Revoking this worker invalidates the token. */
  workerId: string;
  /** The only project `create_issue` may file into. */
  projectId: string;
  /** The assignment. Its token dies when the session is finalized. */
  sessionId: string;
}

export interface IssueFleetMcpTokenInput extends FleetMcpScope {
  ttlMs?: number;
  /** Test seam for expiry. Epoch ms (#614: `nowMs` for arithmetic). */
  nowMs?: number;
}

/** A `{ name, content }` pair in the shape `WorkerRepoTransport.contextFiles` carries. */
export interface RemoteMcpConfigFile {
  name: string;
  content: string;
}

/**
 * The URL a worker should dial for the bridge, derived from the `Host` header of the websocket
 * the worker itself opened.
 *
 * The board must not have to know its own external hostname — the same reasoning that makes the
 * WORKER build the git URL (`composeGitUrl`) instead of the board. Here the answer comes back for
 * free: the worker dialed the fleet listener, so its request carries the exact authority it used.
 * The PORT is taken from the listener rather than the header, because the bridge is served by
 * that listener and nothing else.
 *
 * The header is worker-controlled, and that is harmless: the value only ever returns to the same
 * worker, in its own assignment's config. A worker that wanted to send its own token elsewhere
 * could do so without any help from the board.
 */
export function composeFleetMcpUrl(hostHeader: string | undefined, port: number): string | null {
  const raw = hostHeader?.trim();
  if (!raw) return null;
  // Strip an existing port, keeping IPv6 literals (`[::1]:9100`) intact.
  const hostname = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0]!;
  if (!hostname || hostname === "[") return null;
  return `http://${hostname}:${port}${FLEET_MCP_PATH}`;
}

/** The MCP config file to write into the worker's checkout root. */
export function buildRemoteMcpConfigFile(opts: { url: string; token: string }): RemoteMcpConfigFile {
  const config = {
    mcpServers: {
      "agentic-kanban": {
        type: "http",
        url: opts.url,
        headers: { Authorization: `Bearer ${opts.token}` },
      },
    },
  };
  return { name: REMOTE_MCP_CONFIG_FILENAME, content: `${JSON.stringify(config, null, 2)}\n` };
}

/**
 * The launch args that make a provider load that file — relative, because the agent's cwd IS the
 * checkout root the worker wrote it into (same reasoning as #749's relativized `--attachment`).
 *
 * Only claude and copilot have a config-file channel. Codex reads MCP servers from
 * `~/.codex/config.toml` on the machine it runs on, and pi from its own extension flags, so
 * neither can be pointed at the bridge from argv — a remote codex/pi builder still has no board
 * tools, and its ticket-context file must keep saying so. Disclosed in docs/worker-fleet.md and
 * tracked as #799 (which also carries the missing comment tool and the liveness gap).
 */
export function remoteMcpConfigArgs(provider: string | undefined, filename = REMOTE_MCP_CONFIG_FILENAME): string[] {
  switch (provider ?? "claude") {
    case "claude":
      return ["--mcp-config", filename];
    case "copilot":
      return ["--additional-mcp-config", `@${filename}`];
    default:
      return [];
  }
}

/** Can this provider be pointed at the bridge at all? */
export function providerSupportsRemoteMcp(provider: string | undefined): boolean {
  return remoteMcpConfigArgs(provider).length > 0;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type McpGuardOutcome =
  | { kind: "forward"; payload: unknown }
  | { kind: "deny"; reason: string; response: unknown };

function denial(id: unknown, message: string): unknown {
  // JSON-RPC "method not found" is the honest code: from the agent's side the tool is not there.
  // It rides a 200, as a JSON-RPC error must.
  return { jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message } };
}

/**
 * Decide what happens to ONE JSON-RPC message: forward it (possibly rewritten) or refuse it.
 *
 * Refusal happens here rather than by trusting `tools/list` filtering to hide a tool, because a
 * client that has seen the full surface once (or guessed a name) can still call it. The allowlist
 * is the control; the list filtering only keeps the agent from being shown tools it cannot use.
 */
export function guardMcpMessage(message: unknown, scope: FleetMcpScope): McpGuardOutcome {
  if (!isRecord(message)) return { kind: "forward", payload: message };
  if (message.method !== "tools/call") return { kind: "forward", payload: message };
  const params = isRecord(message.params) ? message.params : {};
  const name = typeof params.name === "string" ? params.name : "";
  if (!REMOTE_BOARD_TOOLS.includes(name)) {
    const reason = `tool "${name}" is not available to a remote fleet worker`;
    return {
      kind: "deny",
      reason,
      response: denial(
        message.id,
        `${reason}. The board MCP bridge exposes only: ${REMOTE_BOARD_TOOLS.join(", ")}. ` +
          "Anything else — merges, preferences, starting or deleting work — belongs to the board, " +
          "not to a builder on another machine. Put it in your final summary instead.",
      ),
    };
  }
  if (name === "create_issue") {
    const args = isRecord(params.arguments) ? params.arguments : {};
    const requested = typeof args.projectId === "string" ? args.projectId : undefined;
    if (requested && requested !== scope.projectId) {
      const reason = `create_issue refused: projectId ${requested} is not this assignment's project`;
      return {
        kind: "deny",
        reason,
        response: denial(
          message.id,
          `${reason} (${scope.projectId}). A remote worker may only file into the project it was dispatched for.`,
        ),
      };
    }
    // Pinned, not merely checked: `create_issue` with no projectId falls back to the board's
    // ACTIVE project, which is the misfiling CLAUDE.md warns about — and a remote builder has no
    // way to know the right id.
    return {
      kind: "forward",
      payload: { ...message, params: { ...params, arguments: { ...args, projectId: scope.projectId } } },
    };
  }
  return { kind: "forward", payload: message };
}

/** Apply {@link guardMcpMessage} to a single message or a JSON-RPC batch. */
export function guardMcpRequest(body: unknown, scope: FleetMcpScope): McpGuardOutcome {
  if (!Array.isArray(body)) return guardMcpMessage(body, scope);
  const out: unknown[] = [];
  for (const message of body) {
    const outcome = guardMcpMessage(message, scope);
    // A batch is refused whole. Partially applying it would leave the client unable to say which
    // half ran, and MCP clients do not batch tool calls in practice.
    if (outcome.kind === "deny") return outcome;
    out.push(outcome.payload);
  }
  return { kind: "forward", payload: out };
}

/**
 * Drop non-allowlisted tools from a `tools/list` result, so the agent is never shown a tool the
 * proxy would refuse. Anything that is not a recognisable tools/list result passes through.
 */
export function filterToolListResponse(body: unknown): unknown {
  if (Array.isArray(body)) return body.map((entry) => filterToolListResponse(entry));
  if (!isRecord(body) || !isRecord(body.result)) return body;
  const tools = body.result.tools;
  if (!Array.isArray(tools)) return body;
  const kept = tools.filter(
    (tool) => isRecord(tool) && typeof tool.name === "string" && REMOTE_BOARD_TOOLS.includes(tool.name),
  );
  return { ...body, result: { ...body.result, tools: kept } };
}

export interface FleetMcpBridge {
  /** Mint a per-assignment token. The clear token is returned once and never stored. */
  issueToken(input: IssueFleetMcpTokenInput): string;
  /** Drop every token for one session — called when the session is finalized. */
  revokeSessionTokens(sessionId: string): number;
  /** Drop every token held by a worker — wired to `registry.onRevoke`, like the git token. */
  revokeWorkerTokens(workerId: string): number;
  /** Record the authority a worker dialed the fleet listener with (its `Host` header). */
  noteWorkerBoardHost(workerId: string, hostHeader: string | undefined): void;
  /** The port the fleet listener actually bound. Null until one is running in this process. */
  endpointPort(): number | null;
  setEndpointPort(port: number | null): void;
  /**
   * Everything needed to point one assignment's agent at the bridge, or null when it cannot be
   * offered (no fleet listener in this process, or the worker's dialed authority is unknown).
   */
  prepareAssignment(input: IssueFleetMcpTokenInput): { url: string; token: string } | null;
  /** The guarded proxy, for mounting on the fleet listener. */
  route(): Hono;
  /** Test seam. */
  tokenCount(): number;
}

function createFleetMcpBridge(database: Database): FleetMcpBridge {
  const tokens = createExpiringDigestStore<FleetMcpScope>({ ttlMs: DEFAULT_FLEET_MCP_TOKEN_TTL_MS });
  const boardHostByWorker = new Map<string, string>();
  let endpointPort: number | null = null;

  const bridge: FleetMcpBridge = {
    issueToken: (input) =>
      tokens.issue(
        { workerId: input.workerId, projectId: input.projectId, sessionId: input.sessionId },
        { ttlMs: input.ttlMs, nowMs: input.nowMs },
      ),
    revokeSessionTokens: (sessionId) => tokens.revokeWhere((scope) => scope.sessionId === sessionId),
    revokeWorkerTokens: (workerId) => {
      boardHostByWorker.delete(workerId);
      return tokens.revokeWhere((scope) => scope.workerId === workerId);
    },
    noteWorkerBoardHost: (workerId, hostHeader) => {
      const host = hostHeader?.trim();
      if (host) boardHostByWorker.set(workerId, host);
    },
    endpointPort: () => endpointPort,
    setEndpointPort: (port) => {
      endpointPort = port;
    },
    prepareAssignment: (input) => {
      if (endpointPort === null) return null;
      const url = composeFleetMcpUrl(boardHostByWorker.get(input.workerId), endpointPort);
      if (!url) return null;
      return { url, token: bridge.issueToken(input) };
    },
    tokenCount: () => tokens.size(),
    route: () => {
      const app = new Hono();
      app.all("/*", async (c) => {
        const token = extractBearer(c.req.header("authorization"));
        const scope = token ? tokens.resolve(token) : null;
        if (!scope) return c.json({ error: "unauthorized" }, 401);

        const upstream = await ensureMcpHttpBridge();
        if (!upstream) {
          console.warn("[fleet-mcp] board MCP listener unavailable — refusing a remote tool call");
          return c.json({ error: "board mcp listener unavailable" }, 503);
        }

        let raw: string | undefined;
        if (c.req.method === "POST") {
          const text = await c.req.text();
          let payload: unknown;
          try {
            payload = text ? JSON.parse(text) : undefined;
          } catch {
            return c.json({ error: "malformed json-rpc body" }, 400);
          }
          const guarded = guardMcpRequest(payload, scope);
          if (guarded.kind === "deny") {
            console.log(
              `[fleet-mcp] denied for worker ${scope.workerId} session ${scope.sessionId}: ${guarded.reason}`,
            );
            return new Response(JSON.stringify(guarded.response), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          raw = JSON.stringify(guarded.payload);
        }

        const headers: Record<string, string> = {
          authorization: `Bearer ${upstream.token}`,
          accept: c.req.header("accept") ?? "application/json, text/event-stream",
        };
        if (raw !== undefined) headers["content-type"] = c.req.header("content-type") ?? "application/json";
        for (const name of ["mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
          const value = c.req.header(name);
          if (value) headers[name] = value;
        }

        let response: Response;
        try {
          response = await fetch(`http://127.0.0.1:${upstream.port}${FLEET_MCP_PATH}`, {
            method: c.req.method,
            headers,
            body: raw,
          });
        } catch (err) {
          console.error("[fleet-mcp] upstream request failed:", err);
          return c.json({ error: "board mcp listener unreachable" }, 502);
        }

        const text = await response.text();
        const contentType = response.headers.get("content-type") ?? "application/json";
        // Only a JSON body can be filtered. The upstream runs with `enableJsonResponse: true`
        // (see mcp-server/src/http-transport.ts), so this is the normal path; anything else is
        // passed through untouched rather than mangled — and cannot leak a tool, because the
        // allowlist above is what actually refuses calls.
        if (!contentType.includes("application/json")) {
          return new Response(text, { status: response.status, headers: { "content-type": contentType } });
        }
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          return new Response(text, { status: response.status, headers: { "content-type": contentType } });
        }
        return new Response(JSON.stringify(filterToolListResponse(parsed)), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      });
      return app;
    },
  };

  // The same revocation contract the git token has (#247): a revoked worker's credential dies
  // now, not at the next board restart. `onRevoke` takes many listeners, so this registers itself
  // instead of being wired from worker-fleet.service.ts.
  getWorkerRegistry(database).onRevoke((workerId) => {
    const removed = bridge.revokeWorkerTokens(workerId);
    if (removed > 0) console.log(`[fleet-mcp] revoked ${removed} board-tool token(s) for worker ${workerId}`);
  });

  return bridge;
}

const bridgeByDb = new WeakMap<object, FleetMcpBridge>();

/** One bridge per database, so the fleet listener and the dispatch path share one token store. */
export function getFleetMcpBridge(database: Database = realDb): FleetMcpBridge {
  let bridge = bridgeByDb.get(database as object);
  if (!bridge) {
    bridge = createFleetMcpBridge(database);
    bridgeByDb.set(database as object, bridge);
  }
  return bridge;
}

/** Test seam — a fresh bridge for a database that already has one. */
export function __resetFleetMcpBridgeForTests(database: Database): void {
  bridgeByDb.delete(database as object);
}
