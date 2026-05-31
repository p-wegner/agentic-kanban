import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { getDiff, getDiffShortstat } from "../../git-service.js";
import { registerGetWorkspaceDiff } from "../../tools/get-workspace-diff.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedIssue, seedProject } from "../helpers/seed.js";

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.toString() || err.message));
      else resolve();
    });
  });
}

describe("get_workspace_diff tool", () => {
  it("returns changed files, diff text, and non-zero stats for a workspace branch", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "ak-mcp-diff-"));

    try {
      await git(repoPath, ["init", "-b", "main"]);
      await git(repoPath, ["config", "user.email", "test@example.com"]);
      await git(repoPath, ["config", "user.name", "Test User"]);
      await writeFile(join(repoPath, "README.md"), "Before\n");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "Initial commit"]);
      await git(repoPath, ["checkout", "-b", "feature/diff-test"]);
      await appendFile(join(repoPath, "README.md"), "After\n");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "Update README"]);

      const { invoke, db } = setupTool(registerGetWorkspaceDiff, { getDiff, getDiffShortstat });
      const { projectId, statusIds } = await seedProject(db);
      const issue = await seedIssue(db, projectId, statusIds["In Progress"]);
      const workspaceId = randomUUID();
      const now = new Date().toISOString();
      await db.insert(schema.workspaces).values({
        id: workspaceId,
        issueId: issue.id,
        branch: "feature/diff-test",
        workingDir: repoPath,
        baseBranch: "main",
        isDirect: false,
        status: "active",
        provider: "codex",
        createdAt: now,
        updatedAt: now,
      });

      const data = parseResult(await invoke({ workspaceId }));

      expect(data.workspaceId).toBe(workspaceId);
      expect(data.baseBranch).toBe("main");
      expect(data.changedFiles).toContain("README.md");
      expect(data.diff).toContain("diff --git a/README.md b/README.md");
      expect(data.diff).toContain("+After");
      expect(data.stats.filesChanged).toBeGreaterThan(0);
      expect(data.stats.insertions).toBeGreaterThan(0);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  }, 30000);
});
