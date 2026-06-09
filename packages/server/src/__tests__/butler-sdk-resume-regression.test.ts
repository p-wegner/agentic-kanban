import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// --- SDK mock ---
const sdkMock = vi.hoisted(() => ({
  calls: [] as Array<{
    options: Record<string, unknown>;
    /** Snapshot of options.resume at call time (the options object is mutated in-place by runLoop). */
    resume: string | undefined;
    sessionId: string;
  }>,
  nextSessionNumber: 1,
  /** When true, query() throws with the thinking-signature error if options.resume is set. */
  failOnResume: false,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ options }: { options: Record<string, unknown> }) => {
    const call = {
      options,
      // Snapshot before runLoop mutates options (it deletes .resume before retrying).
      resume: options.resume as string | undefined,
      sessionId: `sdk-session-${sdkMock.nextSessionNumber++}`,
    };
    sdkMock.calls.push(call);

    // Simulate the cross-profile resume failure: the Anthropic API rejects the
    // resumed transcript because thinking-block signatures are bound to the
    // org/endpoint that produced them.
    if (sdkMock.failOnResume && options.resume) {
      throw new Error(
        "messages.1.content.0: Invalid signature in thinking block",
      );
    }

    let yieldedInit = false;
    const abortSignal = (
      options.abortController as AbortController | undefined
    )?.signal;
    const iterator = {
      setModel: vi.fn(async () => {}),
      supportedCommands: vi.fn(async () => []),
      getContextUsage: vi.fn(async () => ({
        totalTokens: 42,
        maxTokens: 200000,
      })),
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<Record<string, unknown>>> {
        if (!yieldedInit) {
          yieldedInit = true;
          return new Promise((resolve) =>
            queueMicrotask(() =>
              resolve({
                done: false,
                value: {
                  type: "system",
                  subtype: "init",
                  session_id: call.sessionId,
                  model:
                    typeof options.model === "string"
                      ? options.model
                      : "sdk-default-model",
                  mcp_servers: [
                    { name: "agentic-kanban", status: "connected" },
                  ],
                },
              }),
            ),
          );
        }
        if (abortSignal?.aborted) {
          return {
            done: true,
            value: undefined as unknown as Record<string, unknown>,
          };
        }
        return new Promise((resolve) => {
          abortSignal?.addEventListener(
            "abort",
            () =>
              resolve({
                done: true,
                value: undefined as unknown as Record<string, unknown>,
              }),
            { once: true },
          );
        });
      },
    };

    return iterator;
  }),
}));

// Imports must come after vi.mock
import {
  ensureButlerSession,
  sendButlerTurn,
  stopButlerSession,
  getButlerSession,
} from "../services/butler-sdk.service.js";

// --- Helpers ---

function waitForCondition(
  desc: string,
  cond: () => boolean,
  ms = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (cond()) {
        resolve();
        return;
      }
      if (Date.now() - start > ms) {
        reject(new Error(`Timed out waiting for ${desc}`));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

function waitForQueryCalls(n: number) {
  return waitForCondition(
    `${n} SDK query calls (saw ${sdkMock.calls.length})`,
    () => sdkMock.calls.length >= n,
  );
}

function waitForSessionId(projectId: string, sid: string) {
  return waitForCondition(
    `session id ${sid}`,
    () => getButlerSession(projectId).sessionId === sid,
  );
}

/** Let microtasks (runLoop cleanups) drain before the next synchronous step. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// --- Tests ---

describe("Butler SDK resume regression (#710)", () => {
  const toStop: string[] = [];

  beforeEach(() => {
    sdkMock.calls.length = 0;
    sdkMock.nextSessionNumber = 1;
    sdkMock.failOnResume = false;
  });

  afterEach(() => {
    while (toStop.length) stopButlerSession(toStop.pop()!);
  });

  it("recovers from 'Invalid signature in thinking block' on resume by starting a fresh session", async () => {
    sdkMock.failOnResume = true;
    const projectId = randomUUID();
    toStop.push(projectId);

    ensureButlerSession({
      projectId,
      repoPath: process.cwd(),
      projectName: "Resume Regression Test",
      resumeSessionId: "cross-profile-session-abc",
    });

    // First query() threw the signature error → runLoop retried without resume
    await waitForQueryCalls(2);

    // First call attempted resume with the old session id
    expect(sdkMock.calls[0].resume).toBe("cross-profile-session-abc");

    // Second call is a fresh session — no resume
    expect(sdkMock.calls[1].resume).toBeUndefined();

    // Session is active with the NEW session id (from the fresh query)
    await waitForSessionId(projectId, sdkMock.calls[1].sessionId);
    const state = getButlerSession(projectId);
    expect(state.active).toBe(true);
    expect(state.sessionId).toBe(sdkMock.calls[1].sessionId);
  });

  it("accepts a turn on the fresh session after signature-error recovery", async () => {
    sdkMock.failOnResume = true;
    const projectId = randomUUID();
    toStop.push(projectId);

    ensureButlerSession({
      projectId,
      repoPath: process.cwd(),
      projectName: "Resume Regression Test",
      resumeSessionId: "cross-profile-session-def",
    });

    await waitForQueryCalls(2);
    await waitForSessionId(projectId, sdkMock.calls[1].sessionId);

    // The recovered fresh session should accept a turn without errors
    expect(sendButlerTurn(projectId, "hello after recovery")).toBe(true);
    expect(getButlerSession(projectId).busy).toBe(true);
  });

  it("forces a fresh session start when profile changes mid-session", async () => {
    const projectId = randomUUID();
    toStop.push(projectId);

    // Start with profile "anth"
    ensureButlerSession({
      projectId,
      repoPath: process.cwd(),
      projectName: "Profile Switch Test",
      claudeProfile: "anth",
    });

    await waitForQueryCalls(1);
    await waitForSessionId(projectId, sdkMock.calls[0].sessionId);

    const oldSessionId = sdkMock.calls[0].sessionId;
    expect(getButlerSession(projectId)).toMatchObject({
      claudeProfile: "anth",
      sessionId: oldSessionId,
    });

    // Profile switch: stop old session, let its runLoop cleanup drain, then
    // start a new session under a different profile.
    stopButlerSession(projectId);
    await flushMicrotasks();

    ensureButlerSession({
      projectId,
      repoPath: process.cwd(),
      projectName: "Profile Switch Test",
      claudeProfile: "mock",
    });

    await waitForQueryCalls(2);
    await waitForSessionId(projectId, sdkMock.calls[1].sessionId);

    // New session started fresh — no resume of the old session
    expect(sdkMock.calls[1].resume).toBeUndefined();
    expect(getButlerSession(projectId).claudeProfile).toBe("mock");
    expect(getButlerSession(projectId).sessionId).not.toBe(oldSessionId);

    // Turn works on the new-profile session
    expect(sendButlerTurn(projectId, "hello new profile")).toBe(true);
    expect(getButlerSession(projectId).busy).toBe(true);
  });
});
