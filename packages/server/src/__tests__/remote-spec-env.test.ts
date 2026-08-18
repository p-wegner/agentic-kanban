// #244 — the remote launch spec must NOT carry board credentials.
//
// Decision 012 promises "board agent credentials are NEVER sent to a worker".
// Before this test the board serialized a full copy of its own process.env
// (including the selected Claude/Codex/Copilot profile's ANTHROPIC_AUTH_TOKEN,
// ANTHROPIC_BASE_URL and any GITHUB_TOKEN/NPM_TOKEN inherited from the launching
// shell) into every `assign` message, and the worker spawned the agent with that
// map verbatim. This pins both halves of the fix: the allowlist projection, and
// the real assign message built by agent-remote.service.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildRemoteSpecEnv, looksSecretEnvKey, REMOTE_SPEC_ENV_ALLOWLIST } from "../lib/remote-spec-env.js";
import { createRemoteAgentService } from "../services/agent-remote.service.js";
import type { WorkerConnectionManager, WorkerMessageListener } from "../services/worker-connection.service.js";
import type { BoardToWorkerMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";

/** Key shapes that must never appear in a spec env, whatever the board's own env holds. */
const FORBIDDEN_KEY = /^ANTHROPIC_|TOKEN|_KEY$|^KEY$|SECRET|PASSWORD|CREDENTIAL/i;

function assertNoSecrets(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    expect(key, `secret-shaped key leaked into the remote spec: ${key}`).not.toMatch(FORBIDDEN_KEY);
    expect(value, `a secret VALUE leaked into the remote spec under ${key}`).not.toContain("sk-super-secret");
  }
}

function fakeManager(connectedIds: string[]) {
  const sent: Array<{ workerId: string; message: BoardToWorkerMessage }> = [];
  const connected = new Set(connectedIds);
  const manager = {
    handleOpen: () => {},
    handleMessage: () => {},
    handleClose: () => {},
    send: (workerId: string, message: BoardToWorkerMessage) => {
      if (!connected.has(workerId)) return false;
      sent.push({ workerId, message });
      return true;
    },
    isConnected: (id: string) => connected.has(id),
    connectedWorkerIds: () => [...connected],
    runningSessionIds: () => [],
    onMessage: (_l: WorkerMessageListener) => () => {},
    onConnect: (_l: (id: string) => void) => () => {},
    onDisconnect: (_l: (id: string) => void) => () => {},
  } as unknown as WorkerConnectionManager;
  return { manager, sent };
}

describe("remote spec env allowlist (#244)", () => {
  it("keeps board wiring and drops everything else", () => {
    const env = buildRemoteSpecEnv({
      env: {
        KANBAN_SESSION_ID: "s1",
        KANBAN_BOARD_SERVER_PORT: "3001",
        PATH: "C:/Windows/System32",
        HOME: "C:/Users/board-owner",
        USERPROFILE: "C:/Users/board-owner",
        CLAUDE_CONFIG_DIR: "C:/Users/board-owner/.claude-profile",
        ANTHROPIC_AUTH_TOKEN: "sk-super-secret",
        ANTHROPIC_BASE_URL: "https://board.example",
        GITHUB_TOKEN: "sk-super-secret",
        NPM_TOKEN: "sk-super-secret",
        SOME_API_KEY: "sk-super-secret",
      },
      sharesFilesystem: false,
    });
    expect(env.KANBAN_SESSION_ID).toBe("s1");
    expect(env.KANBAN_BOARD_SERVER_PORT).toBe("3001");
    // The worker's own environment must provide these, not the board's.
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.USERPROFILE).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    assertNoSecrets(env);
  });

  it("cannot leak a secret even if its name were added to the allowlist", () => {
    for (const key of REMOTE_SPEC_ENV_ALLOWLIST) {
      expect(looksSecretEnvKey(key), `allowlisted key is credential-shaped: ${key}`).toBe(false);
    }
    expect(looksSecretEnvKey("ANTHROPIC_AUTH_TOKEN")).toBe(true);
    expect(looksSecretEnvKey("GITHUB_TOKEN")).toBe(true);
    expect(looksSecretEnvKey("SOME_API_KEY")).toBe(true);
    expect(looksSecretEnvKey("CODEX_HOME")).toBe(true);
  });

  it("sends board-host paths (GRADLE_USER_HOME) only to a same-filesystem worker", () => {
    const shared = buildRemoteSpecEnv({ env: {}, sharesFilesystem: true, worktreePath: "C:/wt/feature-1" });
    expect(shared.GRADLE_USER_HOME).toBeTruthy();
    const remote = buildRemoteSpecEnv({ env: {}, sharesFilesystem: false, worktreePath: "C:/wt/feature-1" });
    expect(remote.GRADLE_USER_HOME).toBeUndefined();
  });
});

describe("assign messages carry no credentials (#244)", () => {
  let db: Database;
  const saved: Record<string, string | undefined> = {};
  const injected = {
    ANTHROPIC_AUTH_TOKEN: "sk-super-secret",
    ANTHROPIC_BASE_URL: "https://board.example",
    GITHUB_TOKEN: "sk-super-secret",
    MY_SERVICE_API_KEY: "sk-super-secret",
  };

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    for (const [key, value] of Object.entries(injected)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(injected)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("strips every ANTHROPIC_*/*_TOKEN/*_KEY value from the spec env", () => {
    const fm = fakeManager(["w1"]);
    const service = createRemoteAgentService(fm.manager, db);
    service.launch({
      worktreePath: "C:/some/worktree", sessionId: "s1", prompt: "do the ticket",
      agentArgs: undefined, onOutput: () => {},
      agentCommand: "node fleet-mock-agent.cjs",
      claudeProfile: "someprofile",
      keepAlive: false,
      // An auth-rotation dir is a board-local credential path and must not cross
      // either, even though callers pass it for host launches. (#524: this comment
      // used to sit above an argument identified only by its position.)
      extraEnv: { CLAUDE_CONFIG_DIR: "C:/Users/board-owner/.claude-rotated" },
      placement: { kind: "remote", workerId: "w1" },
    });
    expect(fm.sent).toHaveLength(1);
    const msg = fm.sent[0]!.message;
    if (msg.type !== "assign") throw new Error("expected an assign message");
    assertNoSecrets(msg.spec.env);
    expect(msg.spec.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    // ...while the wiring the agent genuinely needs still travels.
    expect(msg.spec.env.KANBAN_SESSION_ID).toBe("s1");
    // And nothing anywhere in the serialized frame contains the secret.
    expect(JSON.stringify(msg)).not.toContain("sk-super-secret");
  });
});
