/**
 * #1431 — `invokeClaudePrompt` is placed like a session when it is given a project: a worker's
 * answer is returned as-is, and anything the placement does not take runs on the host as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.fn();
const execFileMock = vi.fn();

vi.mock("../services/claude-oneshot-worker.service.js", () => ({ dispatchOneShotToWorker: (...a: unknown[]) => dispatch(...a) }));
vi.mock("../repositories/claude-cli.repository.js", () => ({ getClaudeCliPreferences: vi.fn(async () => []) }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (...a: unknown[]) => execFileMock(...a),
}));

const { invokeClaudePrompt } = await import("../services/claude-cli.service.js");
const database = {} as never;

function hostAnswers(text: string): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: null, out: string, err: string) => void) => {
    cb(null, text, "");
    return { stdin: { end: vi.fn() } };
  });
}

beforeEach(() => {
  dispatch.mockReset();
  execFileMock.mockReset();
});

describe("invokeClaudePrompt placement", () => {
  it("returns the worker's text and never spawns on the host", async () => {
    dispatch.mockResolvedValue({ handled: true, text: "from the worker" });
    expect(await invokeClaudePrompt("p", { database, projectId: "proj" })).toBe("from the worker");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ projectId: "proj", prompt: "p", allowEdits: false });
  });

  it("runs on the host when the placement does not take it", async () => {
    dispatch.mockResolvedValue({ handled: false, reason: "no eligible worker" });
    hostAnswers("from the host");
    expect(await invokeClaudePrompt("p", { database, projectId: "proj" })).toBe("from the host");
  });

  it("propagates a strict refusal instead of falling back", async () => {
    dispatch.mockRejectedValue(Object.assign(new Error("strict"), { code: "NO_AVAILABLE_WORKER" }));
    hostAnswers("from the host");
    await expect(invokeClaudePrompt("p", { database, projectId: "proj" })).rejects.toThrow("strict");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not consult placement without a project", async () => {
    hostAnswers("from the host");
    expect(await invokeClaudePrompt("p", { database })).toBe("from the host");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("forwards the repo context and the edit permission of a train fix turn", async () => {
    dispatch.mockResolvedValue({ handled: true, text: "" });
    await invokeClaudePrompt("fix", { database, projectId: "proj", cwd: "/gate", allowEdits: true, repo: { repoPath: "/repo", baseBranch: "master" } });
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ cwd: "/gate", allowEdits: true, repo: { repoPath: "/repo", baseBranch: "master" } });
  });
});
