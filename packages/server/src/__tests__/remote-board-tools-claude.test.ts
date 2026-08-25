/**
 * #857 — a remote CLAUDE builder gets board tools.
 *
 * The predicates in fleet-mcp-bridge.test.ts pin the id/name normalization in isolation. This
 * one asserts the consequence at the only place that matters: the `assign` that goes on the
 * wire. A remote builder that reaches its worker without `--mcp-config`, and with a brief that
 * says it has no board tools, cannot file a ticket or comment a finding — so every convention
 * this repo uses to keep work honest (board-feedback routing, the partial-refactor disclosure
 * rule, reflecting progress at all) is unavailable to it, and findings discovered remotely are
 * structurally likelier to be lost than findings discovered on the host.
 *
 * The launch is driven with `provider: "claude-code"`, which is what `AgentLaunchRequest`
 * actually carries — the spelling under which this silently did not work.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TICKET_CONTEXT_FILENAME } from "@agentic-kanban/shared/lib/ticket-context";
import type { BoardToWorkerMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { WorkerConnectionManager } from "../services/worker-connection.service.js";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { getFleetMcpBridge } from "../services/fleet-mcp-bridge.service.js";
import { createRemoteAgentService } from "../services/agent-remote.service.js";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const WORKER_ID = "w-857";

// `contextFiles` are PATHS on the board; the remote path READS them and ships the content,
// because the board's path names nothing on the worker (#749). So the brief has to be a real
// file for this to exercise the retarget/announce step at all.
const fixtureDir = mkdtempSync(join(tmpdir(), "ak-857-"));
const briefPath = join(fixtureDir, TICKET_CONTEXT_FILENAME);

beforeAll(() => {
  writeFileSync(briefPath, `# Ticket ak-857

Implement the thing.
`);
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

function fakeManager() {
  const sent: Array<{ workerId: string; message: BoardToWorkerMessage }> = [];
  const manager = {
    send: (workerId: string, message: BoardToWorkerMessage) => {
      sent.push({ workerId, message });
      return true;
    },
    isConnected: () => true,
    connectedWorkerIds: () => [WORKER_ID],
    runningSessionIds: () => [],
    onMessage: () => () => {},
    onConnect: () => () => {},
    onDisconnect: () => () => {},
  } as unknown as WorkerConnectionManager;
  return { manager, sent };
}

/** Wait for the assign, which is built in an async continuation after `launch` returns. */
async function assignFor(sent: Array<{ message: BoardToWorkerMessage }>): Promise<
  Extract<BoardToWorkerMessage, { type: "assign" }>
> {
  await vi.waitFor(() => expect(sent.some((s) => s.message.type === "assign")).toBe(true), { timeout: 10_000 });
  return sent.find((s) => s.message.type === "assign")!.message as Extract<
    BoardToWorkerMessage,
    { type: "assign" }
  >;
}

describe("a remote claude builder is handed the board MCP bridge (#857)", () => {
  let db: Database;
  let service: ReturnType<typeof createRemoteAgentService>;
  let sent: Array<{ workerId: string; message: BoardToWorkerMessage }>;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    const bridge = getFleetMcpBridge(db);
    // Stand in for a bound fleet listener that this worker has dialed. Both are the real
    // preconditions `prepareAssignment` checks; nothing else about the bridge is faked.
    bridge.setEndpointPort(9100);
    bridge.noteWorkerBoardHost(WORKER_ID, "board.example:9100");
  });

  afterEach(() => {
    getFleetMcpBridge(db).setEndpointPort(null);
  });

  function launch(provider: string | undefined) {
    const f = fakeManager();
    sent = f.sent;
    service = createRemoteAgentService(f.manager, db);
    service.launch({
      worktreePath: "/tmp/wt",
      sessionId: `sess-${provider ?? "default"}`,
      prompt: "do the ticket",
      agentArgs: undefined,
      onOutput: () => {},
      provider: provider as never,
      contextFiles: [briefPath],
      placement: {
        kind: "remote",
        workerId: WORKER_ID,
        repo: {
          projectId: "proj-1",
          repoPath: "/tmp/repo",
          branch: "feature/ak-857",
          baseBranch: "main",
        },
      },
    });
  }

  it("puts --mcp-config on the assign for provider=claude-code, the id the caller passes", async () => {
    launch("claude-code");
    const assign = await assignFor(sent);
    expect(assign.spec.args).toContain("--mcp-config");
    // The token never travels in argv — it rides in the config file (#769).
    expect(assign.spec.args.join(" ")).not.toContain("Bearer");
  });

  it("ships the MCP config file in the checkout alongside the ticket context", async () => {
    launch("claude-code");
    const assign = await assignFor(sent);
    const names = (assign.repo?.contextFiles ?? []).map((f) => f.name);
    expect(names).toContain(TICKET_CONTEXT_FILENAME);
    expect(names.length).toBeGreaterThan(1);
  });

  it("stops the brief from telling the agent it has no board tools", async () => {
    // The gap was self-fulfilling: even where the transport worked, the brief asserted the
    // negative, so the agent believed it and never tried.
    launch("claude-code");
    const assign = await assignFor(sent);
    const brief = (assign.repo?.contextFiles ?? []).find((f) => f.name === TICKET_CONTEXT_FILENAME);
    expect(brief).toBeDefined();
    expect(brief!.content).toMatch(/mcp__agentic-kanban__/);
  });

  it("is identical for the bare name, so the two spellings cannot diverge again", async () => {
    launch("claude-code");
    const viaId = await assignFor(sent);
    launch("claude");
    const viaName = await assignFor(sent);
    expect(viaId.spec.args.includes("--mcp-config")).toBe(viaName.spec.args.includes("--mcp-config"));
  });

  it("still offers pi nothing — it has no MCP client at all (decision 007)", async () => {
    launch("pi");
    const assign = await assignFor(sent);
    expect(assign.spec.args).not.toContain("--mcp-config");
  });
});
