import { expect, test } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureE2EProject } from "../../global-setup.js";
import { SERVER_URL } from "../helpers/port.js";

test.describe("global setup project registration", () => {
  test("reuses an already-registered repo path and sets it active", async ({ request }) => {
    const activeBeforeRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const activeBefore = activeBeforeRes.ok() ? await activeBeforeRes.json() : { projectId: null };
    const previousProjectId = activeBefore.projectId ?? null;

    const tmpDir = mkdtempSync(join(tmpdir(), "e2e-global-setup-"));
    let projectId: string | null = null;

    try {
      execSync("git init", { cwd: tmpDir });
      execSync("git config user.email test@test.com", { cwd: tmpDir });
      execSync("git config user.name Test", { cwd: tmpDir });

      const createRes = await request.post(`${SERVER_URL}/api/projects`, {
        data: {
          name: `Existing Global Setup Project ${Date.now()}`,
          repoPath: tmpDir,
        },
      });
      expect(createRes.status()).toBe(201);
      const project = await createRes.json();
      projectId = project.id;

      await request.put(`${SERVER_URL}/api/preferences/active-project`, {
        data: { projectId: "" },
      });

      const result = await ensureE2EProject(request, tmpDir, "duplicate-path");
      expect(result.created).toBe(false);
      expect(result.project.id).toBe(projectId);

      const activeAfterRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
      expect(activeAfterRes.ok()).toBe(true);
      await expect(activeAfterRes).toBeOK();
      const activeAfter = await activeAfterRes.json();
      expect(activeAfter.projectId).toBe(projectId);
    } finally {
      if (projectId) {
        await request.delete(`${SERVER_URL}/api/projects/${projectId}`).catch(() => {});
      }
      await request.put(`${SERVER_URL}/api/preferences/active-project`, {
        data: { projectId: previousProjectId ?? "" },
      }).catch(() => {});
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
