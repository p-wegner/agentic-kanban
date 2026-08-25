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
import { findFleetMcpAssignment, isWorkerAssignmentCurrent } from "../repositories/worker.repository.js";
import { FLEET_MCP_TOKEN_ENV_VAR } from "@agentic-kanban/shared/lib/worker-protocol";
import { narrowProviderName } from "./agent-provider.js";

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
 * #769 asked for `add_comment` and there was no such tool on this board, so `list_issues` took
 * its place and progress reflection stayed in the session's own output. #799 built the tool
 * (`packages/mcp-server/src/tools/add-comment.ts`), so it is here now — and it is the only WRITE
 * on this list besides `create_issue`, which is why it is pinned twice over: to the assignment's
 * ISSUE (a remote builder may not comment on an arbitrary ticket) and to the two comment kinds a
 * caller is allowed to author. `preflight-verdict` and `gate-decision` are records of a MACHINE
 * decision; a caller posting one would be forging it, which is why the board's own route refuses
 * them too and why this proxy does not widen that.
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
  // #799 — the one WRITE that is a builder's own voice rather than a board decision.
  "add_comment",
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

/**
 * The comment kinds a remote builder may author (#799).
 *
 * A STRICT SUBSET of the board route's own `userPostableKinds`. That whitelist already refuses
 * `preflight-verdict` and `gate-decision` because they are records of a MACHINE decision and a
 * caller posting one would be forging it. This narrows further: `merge-attempt` and
 * `preflight-clarification` are the board's own workflow bookkeeping, and a builder on another
 * machine has no standing to write either. What is left is exactly the two things a builder
 * legitimately has to say — a note about its own progress, and a question it needs answered.
 */
export const REMOTE_COMMENT_KINDS: readonly string[] = ["note", "agent-question"];

/**
 * What the DB says about an assignment RIGHT NOW, re-derived per request (#799 gap 3).
 *
 * The git transport already re-derives its dispatch on every request (`authorizeAssignment`,
 * #753); the MCP path did not, relying on the token being dropped at `finishSession` /
 * `revokeWorker` plus a 24h TTL. That is fine while the surface is read-only, and it stops being
 * fine the moment a WRITE is on it: a board that crashed mid-session leaves a token valid for up
 * to a day with no assignment behind it. `null` means "no such session", which fails closed.
 */
export interface FleetMcpAssignment {
  /** Session status, as the DB has it. */
  status: string;
  /** The ticket this assignment is for — the only one `add_comment` may write to. */
  issueId: string | null;
  /** When the session ended, if it has. Feeds the shared liveness predicate. */
  endedAt: string | null;
}

/** A scope plus the facts a per-request lookup added to it. */
export type ResolvedFleetMcpScope = FleetMcpScope & { issueId?: string | null };

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
 * The env var a codex builder reads its bearer token from (#799).
 *
 * It is NOT in `REMOTE_SPEC_ENV_ALLOWLIST` and it never will be: `looksSecretEnvKey` drops any
 * key containing `TOKEN` from the launch spec's env by design, which is exactly the rule that
 * keeps board credentials off a worker. So this value does not travel in `spec.env` — it rides
 * `WorkerRepoTransport.boardMcpToken`, the same dedicated, purpose-named field the git token
 * uses, and the WORKER puts it into its own child's environment. The board's env projection
 * stays credential-free and the guard stays un-widened.
 */
export const CODEX_MCP_TOKEN_ENV_VAR = FLEET_MCP_TOKEN_ENV_VAR;

/** The `mcp_servers` entry name a codex builder sees. Matches the claude/copilot config file. */
export const REMOTE_MCP_SERVER_NAME = "agentic-kanban";

export interface RemoteMcpConfigArgsOptions {
  /** Bare filename of the config file, for the providers that read one. */
  filename?: string;
  /** The bridge URL, for the providers configured through argv instead of a file. */
  url?: string;
}

/**
 * The launch args that point a provider at the bridge.
 *
 * THREE CHANNELS, one per provider family, and the difference is not cosmetic — it is about
 * where the TOKEN ends up:
 *
 *  - claude (`--mcp-config <file>`) and copilot (`--additional-mcp-config @<file>`) read a config
 *    FILE. The path is relative because the agent's cwd IS the checkout root the worker wrote it
 *    into (same reasoning as #749's relativized `--attachment`). Token lives in the file.
 *  - codex (#799) has no such flag — it reads `~/.codex/config.toml` on the machine it runs on —
 *    but it does take `-c <dotted.key>=<toml value>` overrides, and an HTTP MCP server entry can
 *    name an ENV VAR to read its bearer token from rather than carrying the token itself. So the
 *    argv carries the URL and the NAME of a variable, never the secret. Pointing `CODEX_HOME` at
 *    the checkout was the obvious alternative and is wrong: that variable also selects the auth
 *    directory, so it would take the worker's own codex login away — decision 012 in reverse.
 *  - pi returns `[]` and still has no channel, which is a fact about pi rather than a gap here:
 *    pi 0.73.1 has no MCP client at all (decision 007 §"no Claude-style MCP config support"), so
 *    there is no configuration that would help. A pi builder's ticket context must keep saying it
 *    has no board tools, and it does. Closing it needs a pi EXTENSION that speaks MCP, which is
 *    upstream work, not board work.
 */
export function remoteMcpConfigArgs(
  provider: string | undefined,
  opts: RemoteMcpConfigArgsOptions | string = {},
): string[] {
  // Back-compat with the #769 call shape `remoteMcpConfigArgs(provider, filename)`.
  const options: RemoteMcpConfigArgsOptions = typeof opts === "string" ? { filename: opts } : opts;
  const filename = options.filename ?? REMOTE_MCP_CONFIG_FILENAME;
  switch (narrowProviderName(provider)) {
    case "claude":
      return ["--mcp-config", filename];
    case "copilot":
      return ["--additional-mcp-config", `@${filename}`];
    case "codex": {
      if (!options.url) return [];
      // TOML values, so the strings are quoted. `-c` parses the right-hand side as TOML and
      // falls back to a raw literal, but relying on that fallback would break the moment a URL
      // contained a character TOML reads as syntax.
      return [
        "-c",
        `mcp_servers.${REMOTE_MCP_SERVER_NAME}.url=${JSON.stringify(options.url)}`,
        "-c",
        `mcp_servers.${REMOTE_MCP_SERVER_NAME}.bearer_token_env_var=${JSON.stringify(CODEX_MCP_TOKEN_ENV_VAR)}`,
      ];
    }
    default:
      return [];
  }
}

/**
 * Can this provider be pointed at the bridge at all?
 *
 * Asked BEFORE a URL is known (the board decides whether to mint a token at all), so codex is
 * answered from the provider name rather than by calling {@link remoteMcpConfigArgs} with no URL.
 *
 * **Normalize through `narrowProviderName` — this is not decoration (#857).** The value that
 * reaches here is an `AgentLaunchRequest.provider`, i.e. a `ProviderId`, whose claude spelling
 * is `"claude-code"`. All three functions in this file used to compare a raw `provider ?? "claude"`
 * against `ProviderName` spellings, so `"claude-code"` fell to the default arm and every remote
 * CLAUDE builder — the overwhelmingly common case — was silently told the bridge was unsupported.
 * It got no MCP config, no board tools, and a ticket brief that asserted it had none, which made
 * the gap self-fulfilling: a remote builder could not file a ticket or comment a finding, so
 * findings discovered remotely were structurally likelier to be lost than findings on the host.
 * `narrowProviderName` is the ONE place the id→name mapping lives; hand-rolling `?? "claude"`
 * beside it is what reintroduced the ladder it exists to replace.
 */
export function providerSupportsRemoteMcp(provider: string | undefined): boolean {
  const name = narrowProviderName(provider);
  return name === "claude" || name === "copilot" || name === "codex";
}

/**
 * Does this provider take its token through the WORKER's env rather than through a file in the
 * checkout? Decides whether `WorkerRepoTransport.boardMcpToken` is populated for an assignment.
 */
export function providerNeedsMcpTokenEnv(provider: string | undefined): boolean {
  return narrowProviderName(provider) === "codex";
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
export function guardMcpMessage(message: unknown, scope: ResolvedFleetMcpScope): McpGuardOutcome {
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
  if (name === "add_comment") return guardAddComment(message, params, scope);
  return { kind: "forward", payload: message };
}

/**
 * `add_comment` is pinned to the assignment's ISSUE and to {@link REMOTE_COMMENT_KINDS} (#799).
 *
 * Pinned rather than merely checked, for the same reason `create_issue`'s project is: a remote
 * builder has no reliable way to name the right id, and the failure mode of guessing is writing
 * onto someone else's ticket. The issue comes from the DB per request, not from the token, so a
 * finalized session cannot comment at all — the caller resolves it and passes it in.
 */
function guardAddComment(message: JsonRecord, params: JsonRecord, scope: ResolvedFleetMcpScope): McpGuardOutcome {
  if (!scope.issueId) {
    const reason = "add_comment refused: this assignment has no live ticket on the board";
    return {
      kind: "deny",
      reason,
      response: denial(
        message.id,
        `${reason} (session ${scope.sessionId}). Either the session has been finalized or its ` +
          "workspace is gone. Put what you wanted to say in your final summary — the board reads it.",
      ),
    };
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  const requestedIssue = typeof args.issueId === "string" ? args.issueId : undefined;
  if (requestedIssue && requestedIssue !== scope.issueId) {
    const reason = `add_comment refused: issueId ${requestedIssue} is not this assignment's ticket`;
    return {
      kind: "deny",
      reason,
      response: denial(
        message.id,
        `${reason} (${scope.issueId}). A remote worker may only comment on the ticket it was ` +
          "dispatched for. To raise something about ANOTHER ticket, use create_issue and reference it.",
      ),
    };
  }
  const requestedKind = typeof args.kind === "string" ? args.kind : undefined;
  if (requestedKind && !REMOTE_COMMENT_KINDS.includes(requestedKind)) {
    const reason = `add_comment refused: kind "${requestedKind}" is not a remote builder's to write`;
    return {
      kind: "deny",
      reason,
      response: denial(
        message.id,
        `${reason}. A remote worker may post ${REMOTE_COMMENT_KINDS.join(" or ")} — the other kinds are ` +
          "records of a decision the BOARD made, and writing one would be forging it.",
      ),
    };
  }
  return {
    kind: "forward",
    payload: {
      ...message,
      params: { ...params, arguments: { ...args, issueId: scope.issueId, kind: requestedKind ?? "note" } },
    },
  };
}

/** Apply {@link guardMcpMessage} to a single message or a JSON-RPC batch. */
export function guardMcpRequest(body: unknown, scope: ResolvedFleetMcpScope): McpGuardOutcome {
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
  /** Test seam — replace the per-request DB assignment lookup (#799). */
  __setAssignmentLookupForTests(lookup: FleetMcpAssignmentLookup): void;
}

/**
 * Per-request assignment resolution (#799 gap 3). Injectable so a test can drive the refusal
 * paths without a `sessions` row, and so the production lookup stays one DB round trip.
 */
export type FleetMcpAssignmentLookup = (scope: FleetMcpScope) => Promise<FleetMcpAssignment | null>;

export function createFleetMcpAssignmentLookup(database: Database): FleetMcpAssignmentLookup {
  return async (scope) => {
    const row = await findFleetMcpAssignment(scope.sessionId, database);
    if (!row) return null;
    // The dispatch must still be THIS worker's. A token outliving a handover to another
    // machine is exactly the shape #753 closed on the git side.
    if (row.workerId !== null && row.workerId !== scope.workerId) return null;
    return { status: row.status, issueId: row.issueId, endedAt: row.endedAt };
  };
}

function createFleetMcpBridge(database: Database): FleetMcpBridge {
  const tokens = createExpiringDigestStore<FleetMcpScope>({ ttlMs: DEFAULT_FLEET_MCP_TOKEN_TTL_MS });
  const boardHostByWorker = new Map<string, string>();
  let endpointPort: number | null = null;
  let lookupAssignment: FleetMcpAssignmentLookup = createFleetMcpAssignmentLookup(database);

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
    __setAssignmentLookupForTests: (lookup) => {
      lookupAssignment = lookup;
    },
    route: () => {
      const app = new Hono();
      app.all("/*", async (c) => {
        const token = extractBearer(c.req.header("authorization"));
        const scope = token ? tokens.resolve(token) : null;
        if (!scope) return c.json({ error: "unauthorized" }, 401);

        // #799 gap 3 — re-derive the assignment from the DB per request, the way the git
        // transport has since #753. Fails CLOSED: a lookup that throws leaves us unable to tell
        // a live builder from a token holder whose session ended, and this surface now carries a
        // write.
        let assignment: FleetMcpAssignment | null;
        try {
          assignment = await lookupAssignment(scope);
        } catch (err) {
          console.error(`[fleet-mcp] assignment lookup failed for session ${scope.sessionId}:`, err);
          return c.json({ error: "assignment lookup failed" }, 503);
        }
        if (!assignment || !isWorkerAssignmentCurrent(assignment, Date.now())) {
          console.log(
            `[fleet-mcp] refused worker ${scope.workerId}: no current dispatch behind session ${scope.sessionId}` +
              `${assignment ? ` (status=${assignment.status})` : " (no such session)"}`,
          );
          // The token is now known to stand for nothing. Dropping it turns every later call into
          // a plain 401 instead of another DB round trip.
          tokens.revokeWhere((s) => s.sessionId === scope.sessionId);
          return c.json({ error: "assignment is no longer current" }, 401);
        }
        const resolved: ResolvedFleetMcpScope = { ...scope, issueId: assignment.issueId };

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
          const guarded = guardMcpRequest(payload, resolved);
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
          // WHY A LOOPBACK HTTP HOP AND NOT AN INJECTED SERVICE CALL. `no-self-http-in-services`
          // exists to stop a service calling its OWN REST API instead of the function behind it.
          // This is the other thing: the target is the #136 MCP StreamableHTTP listener, and MCP's
          // seam IS an HTTP transport — there is no in-process function to inject, only a protocol
          // whose session/`mcp-session-id`/SSE semantics live in the transport. Calling "directly"
          // would mean reimplementing an MCP client, and the inspection this proxy performs
          // (allowlist, project pinning, tools/list filtering) is only possible because the wire
          // format is plain JSON on that hop. The guard currently records this as a grandfathered
          // entry rather than an inline opt-out marker; either form is fine, the reason is here.
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
