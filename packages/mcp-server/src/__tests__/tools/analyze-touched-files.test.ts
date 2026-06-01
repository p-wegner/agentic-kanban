import { describe, it, expect, vi, afterEach } from "vitest";
import { registerAnalyzeTouchedFiles } from "../../tools/analyze-touched-files.js";
import { createToolHarness } from "../helpers/tool-harness.js";

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("analyze_touched_files tool", () => {
  const originalBoardServerPort = process.env.KANBAN_BOARD_SERVER_PORT;
  const originalKanbanServerPort = process.env.KANBAN_SERVER_PORT;
  const originalServerPort = process.env.SERVER_PORT;
  const originalPort = process.env.PORT;

  afterEach(() => {
    restoreEnv("KANBAN_BOARD_SERVER_PORT", originalBoardServerPort);
    restoreEnv("KANBAN_SERVER_PORT", originalKanbanServerPort);
    restoreEnv("SERVER_PORT", originalServerPort);
    restoreEnv("PORT", originalPort);
    vi.restoreAllMocks();
  });

  it("calls the board API through the IPv4 loopback address", async () => {
    delete process.env.KANBAN_BOARD_SERVER_PORT;
    delete process.env.KANBAN_SERVER_PORT;
    process.env.SERVER_PORT = "4321";
    delete process.env.PORT;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ touchedFiles: [] }),
    } as Response);
    const { server, getHandler } = createToolHarness();
    registerAnalyzeTouchedFiles(server);

    await getHandler()({ issueId: "issue-1", refresh: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/api/issues/issue-1/analyze-touched-files",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ refresh: true }),
      }),
    );
  });

  it("prefers the board server port over the worktree server port", async () => {
    process.env.KANBAN_BOARD_SERVER_PORT = "3001";
    process.env.KANBAN_SERVER_PORT = "3268";
    process.env.SERVER_PORT = "3268";
    process.env.PORT = "3268";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ touchedFiles: [] }),
    } as Response);
    const { server, getHandler } = createToolHarness();
    registerAnalyzeTouchedFiles(server);

    await getHandler()({ issueId: "issue-1", refresh: false });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/issues/issue-1/analyze-touched-files",
      expect.any(Object),
    );
  });
});
