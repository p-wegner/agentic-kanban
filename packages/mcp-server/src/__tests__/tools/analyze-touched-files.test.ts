import { describe, it, expect, vi, afterEach } from "vitest";
import { registerAnalyzeTouchedFiles } from "../../tools/analyze-touched-files.js";
import { createToolHarness } from "../helpers/tool-harness.js";

describe("analyze_touched_files tool", () => {
  const originalServerPort = process.env.SERVER_PORT;

  afterEach(() => {
    process.env.SERVER_PORT = originalServerPort;
    vi.restoreAllMocks();
  });

  it("calls the board API through the IPv4 loopback address", async () => {
    process.env.SERVER_PORT = "4321";
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
});
