import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceApiUrl } from "./workspace-api-url.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

describe("workspace CLI API URLs", () => {
  it("uses IPv4 loopback for workspace launch and review requests", () => {
    expect(buildWorkspaceApiUrl("3123", "workspace-1", "launch")).toBe(
      "http://127.0.0.1:3123/api/workspaces/workspace-1/launch",
    );
    expect(buildWorkspaceApiUrl("3123", "workspace-1", "review")).toBe(
      "http://127.0.0.1:3123/api/workspaces/workspace-1/review",
    );
  });

  it("does not construct localhost URLs in the workspace command", async () => {
    const source = await readFile(join(currentDir, "workspace.ts"), "utf8");

    expect(source).not.toContain("http://localhost");
  });
});
