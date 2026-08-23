// The board MCP bridge for remote fleet workers (#769).
//
// The security claim under test is narrow and worth stating: a remote worker gets board TOOLS,
// scoped to one assignment, and the tools it must NOT have are refused BY THE PROXY — not merely
// hidden from `tools/list`. Every deny case here is written in the form a real client would send
// it, and asserted to never reach the upstream listener.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { createServer, type Server } from "node:http";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import {
  REMOTE_BOARD_TOOLS,
  REMOTE_MCP_CONFIG_FILENAME,
  buildRemoteMcpConfigFile,
  composeFleetMcpUrl,
  filterToolListResponse,
  guardMcpRequest,
  getFleetMcpBridge,
  providerNeedsMcpTokenEnv,
  providerSupportsRemoteMcp,
  remoteMcpConfigArgs,
  __resetFleetMcpBridgeForTests,
  CODEX_MCP_TOKEN_ENV_VAR,
  REMOTE_COMMENT_KINDS,
  type FleetMcpScope,
  type ResolvedFleetMcpScope,
} from "../services/fleet-mcp-bridge.service.js";
import { isBareFileName } from "@agentic-kanban/shared/lib/worker-protocol";
import {
  BOARD_FEEDBACK_HEADING,
  REMOTE_WORKER_HEADING,
  announceRemoteBoardTools,
  buildRemoteWorkerSection,
} from "@agentic-kanban/shared/lib/ticket-context";

// The upstream #136 listener is a spawned child process in production. Here it is a stub that
// RECORDS what reached it — the assertion "a denied tool never touched a tool" needs a witness.
const upstream = vi.hoisted(() => ({ port: 0, token: "upstream-token", received: [] as unknown[], reply: null as unknown }));

vi.mock("../services/mcp-http-bridge.service.js", () => ({
  ensureMcpHttpBridge: async () => (upstream.port === 0 ? null : { port: upstream.port, token: upstream.token }),
}));

let stub: Server | undefined;

async function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      upstream.received.push({
        authorization: req.headers.authorization,
        body: body ? JSON.parse(body) : undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstream.reply ?? { jsonrpc: "2.0", id: 1, result: { ok: true } }));
    });
  });
  await new Promise<void>((resolve) => stub!.listen(0, "127.0.0.1", () => resolve()));
  const address = stub.address();
  upstream.port = typeof address === "object" && address !== null ? address.port : 0;
}

afterAll(async () => {
  await new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve()));
});

const SCOPE: FleetMcpScope = { workerId: "w-1", projectId: "proj-a", sessionId: "sess-1" };
/** What the route hands the guard once it has re-derived the assignment from the DB (#799). */
const RESOLVED: ResolvedFleetMcpScope = { ...SCOPE, issueId: "issue-a" };

function call(name: string, args?: Record<string, unknown>, id = 7): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, ...(args ? { arguments: args } : {}) } };
}

describe("fleet MCP bridge — the allowlist (#769)", () => {
  it("forwards a permitted tool", () => {
    const outcome = guardMcpRequest(call("get_issue", { issueNumber: 12 }), RESOLVED);
    expect(outcome.kind).toBe("forward");
  });

  // The point of the ticket: prove the DENY, in the exact form a client sends it.
  it.each(["merge_workspace", "set_preference", "delete_issue", "update_issue", "start_workspace", "relaunch_workspace"])(
    "denies %s",
    (tool) => {
      const outcome = guardMcpRequest(call(tool), RESOLVED);
      expect(outcome.kind).toBe("deny");
      if (outcome.kind !== "deny") return;
      expect(outcome.reason).toContain(tool);
      const response = outcome.response as { id: unknown; error: { code: number; message: string } };
      expect(response.id).toBe(7);
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain(tool);
    },
  );

  it("keeps merge/preference/delete tools out of the allowlist itself", () => {
    for (const forbidden of ["merge_workspace", "mark_ready_for_merge", "close_workspace", "set_preference", "delete_issue"]) {
      expect(REMOTE_BOARD_TOOLS).not.toContain(forbidden);
    }
  });

  it("pins create_issue to the assignment's project when the caller omits it", () => {
    const outcome = guardMcpRequest(call("create_issue", { title: "found a thing" }), RESOLVED);
    expect(outcome.kind).toBe("forward");
    if (outcome.kind !== "forward") return;
    const payload = outcome.payload as { params: { arguments: { projectId: string } } };
    expect(payload.params.arguments.projectId).toBe("proj-a");
  });

  it("refuses create_issue aimed at another project", () => {
    const outcome = guardMcpRequest(call("create_issue", { title: "x", projectId: "proj-b" }), RESOLVED);
    expect(outcome.kind).toBe("deny");
    if (outcome.kind !== "deny") return;
    expect(outcome.reason).toContain("proj-b");
  });

  it("refuses a batch whole when any member is denied", () => {
    const outcome = guardMcpRequest([call("get_issue"), call("merge_workspace")], RESOLVED);
    expect(outcome.kind).toBe("deny");
  });

  it("passes non-tools/call traffic through untouched", () => {
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    expect(guardMcpRequest(initialize, RESOLVED)).toEqual({ kind: "forward", payload: initialize });
  });

  it("hides denied tools from tools/list", () => {
    const filtered = filterToolListResponse({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "get_issue" }, { name: "merge_workspace" }, { name: "set_preference" }] },
    }) as { result: { tools: { name: string }[] } };
    expect(filtered.result.tools.map((t) => t.name)).toEqual(["get_issue"]);
  });

  it("leaves a non-tools/list response alone", () => {
    const body = { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "hi" }] } };
    expect(filterToolListResponse(body)).toEqual(body);
  });
});

describe("fleet MCP bridge — the config the worker receives", () => {
  it("names a BARE file the worker is allowed to write into its checkout root", () => {
    const file = buildRemoteMcpConfigFile({ url: "http://board:9100/mcp", token: "tok" });
    expect(file.name).toBe(REMOTE_MCP_CONFIG_FILENAME);
    // `provisionWorkerCheckout` refuses anything else, so a name change must fail here first.
    expect(isBareFileName(file.name)).toBe(true);
    // NOT `.mcp.json`, which Claude Code would auto-load for every later session in that dir.
    expect(file.name).not.toBe(".mcp.json");
    const parsed = JSON.parse(file.content);
    expect(parsed.mcpServers["agentic-kanban"]).toEqual({
      type: "http",
      url: "http://board:9100/mcp",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("carries the token in the CONFIG FILE, never in argv", () => {
    const args = remoteMcpConfigArgs("claude");
    expect(args).toEqual(["--mcp-config", REMOTE_MCP_CONFIG_FILENAME]);
    expect(args.join(" ")).not.toContain("Bearer");
    expect(remoteMcpConfigArgs("copilot")).toEqual(["--additional-mcp-config", `@${REMOTE_MCP_CONFIG_FILENAME}`]);
  });

  it("configures codex through argv and its token through the WORKER's env (#799)", () => {
    const url = "http://board:9100/mcp";
    const args = remoteMcpConfigArgs("codex", { url });
    // The URL and the NAME of an env var — never the secret. A token in argv is visible in
    // any process listing on the worker, which is the whole reason the file channel exists.
    expect(args).toEqual([
      "-c",
      `mcp_servers.agentic-kanban.url=${JSON.stringify(url)}`,
      "-c",
      `mcp_servers.agentic-kanban.bearer_token_env_var=${JSON.stringify(CODEX_MCP_TOKEN_ENV_VAR)}`,
    ]);
    expect(args.join(" ")).not.toContain("Bearer");
    expect(providerSupportsRemoteMcp("codex")).toBe(true);
    expect(providerNeedsMcpTokenEnv("codex")).toBe(true);
    // No URL yet (the fleet listener has not bound) = no half-configured flag.
    expect(remoteMcpConfigArgs("codex")).toEqual([]);
    // claude/copilot keep the FILE channel, so no env token for them.
    expect(providerNeedsMcpTokenEnv("claude")).toBe(false);
    expect(providerNeedsMcpTokenEnv("copilot")).toBe(false);
  });

  it("still has no channel for pi, because pi has no MCP client (#799)", () => {
    // Not a gap in the bridge: pi 0.73.1 has no MCP support at all (decision 007), so there
    // is no configuration that would help. A pi builder's brief must keep saying it has no
    // board tools — asserted here so a future "fix" cannot quietly ship a flag pi ignores.
    expect(remoteMcpConfigArgs("pi", { url: "http://board:9100/mcp" })).toEqual([]);
    expect(providerSupportsRemoteMcp("pi")).toBe(false);
    expect(providerSupportsRemoteMcp("claude")).toBe(true);
  });

  it("composes the URL from the authority the worker itself dialed", () => {
    expect(composeFleetMcpUrl("board.tail1234.ts.net:9100", 9100)).toBe("http://board.tail1234.ts.net:9100/mcp");
    // A header with no port, and one whose port differs from the listener's: the LISTENER's port wins.
    expect(composeFleetMcpUrl("10.0.0.4", 9100)).toBe("http://10.0.0.4:9100/mcp");
    expect(composeFleetMcpUrl("10.0.0.4:80", 9100)).toBe("http://10.0.0.4:9100/mcp");
    expect(composeFleetMcpUrl("[::1]:9100", 9100)).toBe("http://[::1]:9100/mcp");
    expect(composeFleetMcpUrl(undefined, 9100)).toBeNull();
    expect(composeFleetMcpUrl("  ", 9100)).toBeNull();
  });
});

describe("fleet MCP bridge — token scoping and lifetime", () => {
  let db: Database;
  let bridge: ReturnType<typeof getFleetMcpBridge>;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    __resetFleetMcpBridgeForTests(db);
    bridge = getFleetMcpBridge(db);
  });

  it("offers nothing until a fleet listener has bound a port", () => {
    bridge.noteWorkerBoardHost("w-1", "board:9100");
    expect(bridge.prepareAssignment(SCOPE)).toBeNull();
    bridge.setEndpointPort(9100);
    expect(bridge.prepareAssignment(SCOPE)).toEqual({ url: "http://board:9100/mcp", token: expect.any(String) });
  });

  it("offers nothing for a worker whose dialed authority is unknown", () => {
    bridge.setEndpointPort(9100);
    expect(bridge.prepareAssignment(SCOPE)).toBeNull();
  });

  it("expires, and dies with its session or its worker", () => {
    bridge.setEndpointPort(9100);
    bridge.noteWorkerBoardHost("w-1", "board:9100");
    bridge.issueToken({ ...SCOPE, ttlMs: 1000, nowMs: 0 });
    expect(bridge.tokenCount()).toBe(1);

    bridge.issueToken({ ...SCOPE, sessionId: "sess-2" });
    expect(bridge.revokeSessionTokens("sess-2")).toBe(1);

    bridge.issueToken({ ...SCOPE, sessionId: "sess-3" });
    expect(bridge.revokeWorkerTokens("w-1")).toBeGreaterThan(0);
    expect(bridge.tokenCount()).toBe(0);
    // The dialed authority goes too — a revoked worker must not be re-offered a bridge.
    bridge.setEndpointPort(9100);
    expect(bridge.prepareAssignment(SCOPE)).toBeNull();
  });
});

describe("fleet MCP bridge — the proxy end to end", () => {
  let db: Database;
  let bridge: ReturnType<typeof getFleetMcpBridge>;
  let app: Hono;
  let token: string;

  beforeEach(async () => {
    if (!stub) await startStub();
    upstream.received = [];
    upstream.reply = null;
    db = createTestDb().db as unknown as Database;
    __resetFleetMcpBridgeForTests(db);
    bridge = getFleetMcpBridge(db);
    // #799 gap 3 — the route re-derives the assignment from the DB per request. These tests
    // drive the proxy, not the query, so the lookup is stubbed to a live assignment; the
    // refusal paths get their own block below.
    bridge.__setAssignmentLookupForTests(async () => ({ status: "running", issueId: "issue-a", endedAt: null }));
    bridge.setEndpointPort(9100);
    token = bridge.issueToken(SCOPE);
    app = new Hono();
    app.route("/mcp", bridge.route());
  });

  async function post(body: unknown, bearer: string | null = token): Promise<Response> {
    return app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("401s with no token, a wrong token, or a revoked one", async () => {
    expect((await post(call("get_issue"), null)).status).toBe(401);
    expect((await post(call("get_issue"), "0".repeat(64))).status).toBe(401);
    bridge.revokeWorkerTokens("w-1");
    expect((await post(call("get_issue"))).status).toBe(401);
    expect(upstream.received).toHaveLength(0);
  });

  it("forwards a permitted call with the UPSTREAM token, not the worker's", async () => {
    const res = await post(call("get_issue", { issueNumber: 4 }));
    expect(res.status).toBe(200);
    expect(upstream.received).toHaveLength(1);
    const seen = upstream.received[0] as { authorization: string; body: { params: { name: string } } };
    expect(seen.authorization).toBe(`Bearer ${upstream.token}`);
    expect(seen.authorization).not.toContain(token);
    expect(seen.body.params.name).toBe("get_issue");
  });

  it("a denied tool never reaches the board's tools", async () => {
    const res = await post(call("merge_workspace", { workspaceId: "ws-1" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain("merge_workspace");
    expect(upstream.received).toHaveLength(0);
  });

  it("filters tools/list on the way back", async () => {
    upstream.reply = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "get_issue" }, { name: "delete_issue" }, { name: "get_board_status" }] },
    };
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual(["get_issue", "get_board_status"]);
  });

  it("503s when the board's own MCP listener is not available", async () => {
    const realPort = upstream.port;
    upstream.port = 0;
    try {
      expect((await post(call("get_issue"))).status).toBe(503);
    } finally {
      upstream.port = realPort;
    }
  });

  it("rejects a malformed body without forwarding it", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(upstream.received).toHaveLength(0);
  });
});

describe("the brief a remote worker reads (#749 text, #769 correction)", () => {
  const rendered = [
    "# Ticket #5: something",
    "",
    buildRemoteWorkerSection(),
    "",
    `${BOARD_FEEDBACK_HEADING}`,
    "",
    "report it upstream",
  ].join("\n");

  it("still says there are no board tools when no bridge is offered", () => {
    expect(buildRemoteWorkerSection()).toContain("No board tools");
    expect(announceRemoteBoardTools(rendered, { boardTools: [] })).toBe(rendered);
  });

  it("names the tools that DO work once a bridge is offered", () => {
    const updated = announceRemoteBoardTools(rendered, { boardTools: REMOTE_BOARD_TOOLS });
    expect(updated).not.toContain("No board tools");
    for (const tool of REMOTE_BOARD_TOOLS) expect(updated).toContain(`mcp__agentic-kanban__${tool}`);
    expect(updated).toContain("REFUSED by the bridge");
    // Neither neighbour is disturbed: the heading above and the feedback section below survive.
    expect(updated).toContain("# Ticket #5: something");
    expect(updated).toContain(BOARD_FEEDBACK_HEADING);
    expect(updated.indexOf(REMOTE_WORKER_HEADING)).toBeLessThan(updated.indexOf(BOARD_FEEDBACK_HEADING));
    expect(updated).toContain("report it upstream");
  });

  it("leaves a file with no remote-worker section alone", () => {
    expect(announceRemoteBoardTools("# just a ticket\n", { boardTools: REMOTE_BOARD_TOOLS })).toBe("# just a ticket\n");
  });
});

/**
 * #799 — the two gaps #769 disclosed, plus the liveness check that widening the surface made
 * mandatory.
 *
 * The through-line: `add_comment` is the FIRST write on this bridge that is not `create_issue`,
 * and a write is what turns "the token is dropped when the session ends" from adequate into a
 * 24-hour hole. So the pinning and the per-request re-derivation are tested together — they are
 * one change, not two.
 */
describe("fleet MCP bridge — add_comment is pinned to the assignment (#799)", () => {
  it("pins the issue when the caller omits it, and defaults the kind to a note", () => {
    const outcome = guardMcpRequest(call("add_comment", { body: "halfway through the refactor" }), RESOLVED);
    expect(outcome.kind).toBe("forward");
    if (outcome.kind !== "forward") return;
    const payload = outcome.payload as { params: { arguments: { issueId: string; kind: string } } };
    expect(payload.params.arguments.issueId).toBe("issue-a");
    expect(payload.params.arguments.kind).toBe("note");
  });

  it("refuses a comment aimed at ANOTHER ticket", () => {
    const outcome = guardMcpRequest(call("add_comment", { issueId: "issue-b", body: "x" }), RESOLVED);
    expect(outcome.kind).toBe("deny");
    if (outcome.kind !== "deny") return;
    expect(outcome.reason).toContain("issue-b");
    // The refusal has to say what to do instead, or an agent just retries it.
    const response = outcome.response as { error: { message: string } };
    expect(response.error.message).toContain("create_issue");
  });

  it("refuses a kind that records a MACHINE decision", () => {
    for (const kind of ["preflight-verdict", "gate-decision", "merge-attempt", "preflight-clarification"]) {
      const outcome = guardMcpRequest(call("add_comment", { body: "x", kind }), RESOLVED);
      expect(outcome.kind, `${kind} must be refused`).toBe("deny");
    }
    for (const kind of REMOTE_COMMENT_KINDS) {
      expect(guardMcpRequest(call("add_comment", { body: "x", kind }), RESOLVED).kind).toBe("forward");
    }
  });

  it("refuses entirely when the assignment has no live ticket", () => {
    const outcome = guardMcpRequest(call("add_comment", { body: "x" }), { ...SCOPE, issueId: null });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind !== "deny") return;
    expect(outcome.reason).toContain("no live ticket");
  });

  it("is on the allowlist, and is the only write there besides create_issue", () => {
    expect(REMOTE_BOARD_TOOLS).toContain("add_comment");
    // A reader should be able to see the write surface at a glance; this fails if one grows.
    expect(REMOTE_BOARD_TOOLS.filter((t) => t.startsWith("create_") || t.startsWith("add_"))).toEqual([
      "create_issue",
      "add_comment",
    ]);
  });
});

describe("fleet MCP bridge — the assignment is re-derived per request (#799 gap 3)", () => {
  let db: Database;
  let bridge: ReturnType<typeof getFleetMcpBridge>;
  let app: Hono;
  let token: string;

  beforeEach(async () => {
    if (!stub) await startStub();
    upstream.received = [];
    upstream.reply = null;
    db = createTestDb().db as unknown as Database;
    __resetFleetMcpBridgeForTests(db);
    bridge = getFleetMcpBridge(db);
    bridge.setEndpointPort(9100);
    token = bridge.issueToken(SCOPE);
    app = new Hono();
    app.route("/mcp", bridge.route());
  });

  const post = async (): Promise<Response> =>
    app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(call("get_issue", { issueNumber: 1 })),
    });

  it("refuses when the DB has no such session — the board-crash hole #769 disclosed", async () => {
    bridge.__setAssignmentLookupForTests(async () => null);
    expect((await post()).status).toBe(401);
    expect(upstream.received).toHaveLength(0);
  });

  it("refuses once the session is finalized, even inside the token's 24h TTL", async () => {
    // Ended long enough ago that `isWorkerAssignmentCurrent`'s landable window has closed.
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    bridge.__setAssignmentLookupForTests(async () => ({ status: "completed", issueId: "issue-a", endedAt: longAgo }));
    expect((await post()).status).toBe(401);
    expect(upstream.received).toHaveLength(0);
  });

  it("drops the token once it is known to stand for nothing", async () => {
    bridge.__setAssignmentLookupForTests(async () => null);
    expect((await post()).status).toBe(401);
    // The second call is a plain unauthorized: no second DB round trip for a dead token.
    expect(bridge.tokenCount()).toBe(0);
  });

  it("fails CLOSED when the lookup throws", async () => {
    bridge.__setAssignmentLookupForTests(async () => {
      throw new Error("db is gone");
    });
    expect((await post()).status).toBe(503);
    expect(upstream.received).toHaveLength(0);
  });

  it("allows a session that ended within the result window, like the git transport does", async () => {
    const justNow = new Date(Date.now() - 60_000).toISOString();
    bridge.__setAssignmentLookupForTests(async () => ({ status: "completed", issueId: "issue-a", endedAt: justNow }));
    expect((await post()).status).toBe(200);
    expect(upstream.received).toHaveLength(1);
  });
});
