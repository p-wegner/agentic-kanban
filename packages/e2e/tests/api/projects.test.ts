import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("@smoke: Projects API", () => {
  let projectId: string;

  test.beforeAll(async ({ request }) => {
    // Use the dedicated E2E project set by global-setup (not projects[0] which may be a real project).
    projectId = await getE2EProjectId(request);
  });

  test("GET /api/projects returns list", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/projects`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    // Each project should have expected fields
    const project = body[0];
    expect(project.id).toBeDefined();
    expect(project.name).toBeDefined();
    expect(project.repoPath).toBeDefined();
  });

  test("POST /api/projects creates project with git info auto-detection", async ({
    request,
  }) => {
    // Create a temporary git repo for the test
    const tmpDir = mkdtempSync(join(tmpdir(), "e2e-project-"));
    execSync("git init", { cwd: tmpDir });
    execSync("git config user.email test@test.com", { cwd: tmpDir });
    execSync("git config user.name Test", { cwd: tmpDir });

    const res = await request.post(`${SERVER_URL}/api/projects`, {
      data: {
        name: "E2E Test Project " + Date.now(),
        repoPath: tmpDir,
      },
    });

    // Clean up temp dir
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBeDefined();
    expect(body.repoPath).toBeDefined();

    // Clean up the temporary project
    if (body?.id) {
      await request.delete(`${SERVER_URL}/api/projects/${body.id}`);
    }
  });

  test("POST /api/projects rejects missing repoPath", async ({ request }) => {
    const res = await request.post(`${SERVER_URL}/api/projects`, {
      data: { name: "No repo project" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("repoPath");
  });

  test("GET /api/projects/:id/statuses returns statuses", async ({
    request,
  }) => {
    const res = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(5); // 5 default statuses
    // Statuses should be ordered by sortOrder
    const names = body.map((s: { name: string }) => s.name);
    expect(names).toContain("Todo");
    expect(names).toContain("In Progress");
    expect(names).toContain("In Review");
    expect(names).toContain("Done");
    expect(names).toContain("Cancelled");
  });

  // #696 — this was `test.skip(true, …)` from 2026-06-17 to 2026-08-20 because it added a
  // column to the SHARED E2E project, which broke other tests' board column-count assertions.
  // A permanent skip meant project-column creation — a write endpoint — had no coverage at
  // all for two months. The interference was the shared fixture, not the assertion, so the
  // test now creates its OWN throwaway project (the same temp-repo pattern the create-project
  // test above uses) and deletes it, which cannot affect any other test's column count.
  test("POST /api/projects/:id/statuses creates a new status", async ({
    request,
  }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "e2e-status-"));
    execSync("git init", { cwd: tmpDir });
    execSync("git config user.email test@test.com", { cwd: tmpDir });
    execSync("git config user.name Test", { cwd: tmpDir });

    let ownProjectId: string | undefined;
    try {
      const createRes = await request.post(`${SERVER_URL}/api/projects`, {
        data: { name: "E2E Status Project " + Date.now(), repoPath: tmpDir },
      });
      expect(createRes.status()).toBe(201);
      ownProjectId = (await createRes.json()).id as string;
      expect(ownProjectId).toBeDefined();

      const statusName = `Test Status ${Date.now()}`;
      const res = await request.post(
        `${SERVER_URL}/api/projects/${ownProjectId}/statuses`,
        {
          data: { name: statusName, sortOrder: 99 },
        },
      );
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.name).toBe(statusName);
      expect(body.projectId).toBe(ownProjectId);

      // Verify it appears in the list — the assertion the skip was costing us.
      const listRes = await request.get(
        `${SERVER_URL}/api/projects/${ownProjectId}/statuses`,
      );
      const list = await listRes.json();
      expect(
        list.some((s: { name: string }) => s.name === statusName),
      ).toBeTruthy();
    } finally {
      // Deleting the project removes its columns with it, so nothing leaks into the shared
      // board even if an assertion above fails.
      if (ownProjectId) {
        await request.delete(`${SERVER_URL}/api/projects/${ownProjectId}`).catch(() => {});
      }
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("GET /api/projects/:id/branches returns branches", async ({
    request,
  }) => {
    const res = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/branches`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body).toBe("object");
    // Response has local and remote branch arrays
    expect(Array.isArray(body.local)).toBe(true);
    expect(body.local.length).toBeGreaterThanOrEqual(1);
    // Remote branches also present
    expect(Array.isArray(body.remote)).toBe(true);
  });

  test("GET /api/projects/:id/branches returns 404 for invalid project", async ({
    request,
  }) => {
    const res = await request.get(
      `${SERVER_URL}/api/projects/non-existent-id/branches`,
    );
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });
});
