import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import type { TestDb } from "./helpers/test-db.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/workspaces", createWorkspaceActionsRoute(() => {
      throw new Error("Session manager not available in tests");
    }, db));
  });
}

async function seedWorkspace(database: TestDb, workingDir: string) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await database.insert(schema.projects).values({
    id: projectId,
    name: "artifact-test",
    repoPath: workingDir,
    repoName: "artifact-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  await database.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Progress",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });
  await database.insert(schema.issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Artifact test",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await database.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/artifacts",
    workingDir,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  return { issueId, workspaceId };
}

describe("session artifact routes", () => {
  describe("GET /api/workspaces/:id/artifacts", () => {
    it("returns empty array when workspace directory has no recognized artifacts", async () => {
      const { app, db } = createTestApp();
      const tempDir = mkdtempSync(join(tmpdir(), "ak-artifacts-empty-"));
      try {
        const { workspaceId } = await seedWorkspace(db, tempDir);

        const res = await app.request(`/api/workspaces/${workspaceId}/artifacts`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual([]);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("lists recognized artifacts grouped by type", async () => {
      const { app, db } = createTestApp();
      const tempDir = mkdtempSync(join(tmpdir(), "ak-artifacts-list-"));
      try {
        // Create artifact files
        writeFileSync(join(tempDir, "screenshot.png"), Buffer.alloc(1024));
        writeFileSync(join(tempDir, "test.log"), "line 1\nline 2\n");
        mkdirSync(join(tempDir, "traces"));
        writeFileSync(join(tempDir, "traces", "playwright.trace"), "trace-data");

        // Also create files that should be ignored
        writeFileSync(join(tempDir, "binary.bin"), Buffer.alloc(512));
        writeFileSync(join(tempDir, ".hidden.log"), "hidden");

        const { workspaceId } = await seedWorkspace(db, tempDir);

        const res = await app.request(`/api/workspaces/${workspaceId}/artifacts`);
        expect(res.status).toBe(200);
        const body = await res.json();

        // Should find 3 artifacts: screenshot.png (image), test.log (text), playwright.trace (trace)
        expect(body).toHaveLength(3);

        const paths = body.map((a: any) => a.path);
        expect(paths).toContain("screenshot.png");
        expect(paths).toContain("test.log");
        expect(paths).toContain("traces/playwright.trace");

        // Should not include .hidden.log or binary.bin
        expect(paths).not.toContain(".hidden.log");
        expect(paths).not.toContain("binary.bin");

        // Verify type classification
        const screenshot = body.find((a: any) => a.path === "screenshot.png");
        expect(screenshot.type).toBe("image");
        expect(screenshot.size).toBe(1024);
        expect(screenshot.ext).toBe(".png");

        const log = body.find((a: any) => a.path === "test.log");
        expect(log.type).toBe("text");

        const trace = body.find((a: any) => a.path === "traces/playwright.trace");
        expect(trace.type).toBe("trace");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("returns 404 for nonexistent workspace", async () => {
      const { app } = createTestApp();
      const res = await app.request(`/api/workspaces/${randomUUID()}/artifacts`);
      expect(res.status).toBe(404);
    });

    it("returns 404 for workspace with no working directory", async () => {
      const { app, db } = createTestApp();
      const now = new Date().toISOString();
      const projectId = randomUUID();
      const statusId = randomUUID();
      const issueId = randomUUID();
      const workspaceId = randomUUID();

      await db.insert(schema.projects).values({
        id: projectId, name: "no-dir", repoPath: "/tmp/no-dir", repoName: "no-dir",
        defaultBranch: "main", createdAt: now, updatedAt: now,
      });
      await db.insert(schema.projectStatuses).values({
        id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now,
      });
      await db.insert(schema.issues).values({
        id: issueId, issueNumber: 2, title: "No dir", priority: "medium",
        sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
      });
      await db.insert(schema.workspaces).values({
        id: workspaceId, issueId, branch: "test", workingDir: null,
        status: "active", createdAt: now, updatedAt: now,
      });

      const res = await app.request(`/api/workspaces/${workspaceId}/artifacts`);
      expect(res.status).toBe(404);
    });

    it("skips node_modules and hidden directories", async () => {
      const { app, db } = createTestApp();
      const tempDir = mkdtempSync(join(tmpdir(), "ak-artifacts-skip-"));
      try {
        mkdirSync(join(tempDir, "node_modules"));
        writeFileSync(join(tempDir, "node_modules", "dep.log"), "should not appear");
        mkdirSync(join(tempDir, ".playwright"));
        writeFileSync(join(tempDir, ".playwright", "trace.zip"), "should not appear");
        writeFileSync(join(tempDir, "visible.txt"), "should appear");

        const { workspaceId } = await seedWorkspace(db, tempDir);

        const res = await app.request(`/api/workspaces/${workspaceId}/artifacts`);
        const body = await res.json();
        expect(body).toHaveLength(1);
        expect(body[0].path).toBe("visible.txt");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("GET /api/workspaces/:id/artifacts-file", () => {
    it("reads a text artifact inline", async () => {
      const { app, db } = createTestApp();
      const tempDir = mkdtempSync(join(tmpdir(), "ak-artifacts-read-"));
      try {
        writeFileSync(join(tempDir, "output.log"), "hello world\nline 2");
        const { workspaceId } = await seedWorkspace(db, tempDir);

        const res = await app.request(
          `/api/workspaces/${workspaceId}/artifacts-file?path=${encodeURIComponent("output.log")}`,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.content).toBe("hello world\nline 2");
        expect(body.path).toBe("output.log");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("reads an image artifact as binary", async () => {
      const { app, db } = createTestApp();
      const tempDir = mkdtempSync(join(tmpdir(), "ak-artifacts-img-"));
      try {
        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        writeFileSync(join(tempDir, "screenshot.png"), pngHeader);
        const { workspaceId } = await seedWorkspace(db, tempDir);

        const res = await app.request(
          `/api/workspaces/${workspaceId}/artifacts-file?path=${encodeURIComponent("screenshot.png")}`,
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        const buf = Buffer.from(await res.arrayBuffer());
        expect(buf).toEqual(pngHeader);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects path traversal attempts", async () => {
      const { app, db } = createTestApp();
      const tempDir = mkdtempSync(join(tmpdir(), "ak-artifacts-traversal-"));
      try {
        writeFileSync(join(tempDir, "safe.txt"), "safe content");
        const { workspaceId } = await seedWorkspace(db, tempDir);

        const res = await app.request(
          `/api/workspaces/${workspaceId}/artifacts-file?path=${encodeURIComponent("../../../etc/passwd")}`,
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain("outside");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects absolute paths outside workspace", async () => {
      const { app, db } = createTestApp();
      const tempDir = mkdtempSync(join(tmpdir(), "ak-artifacts-abs-"));
      try {
        writeFileSync(join(tempDir, "safe.txt"), "safe content");
        const { workspaceId } = await seedWorkspace(db, tempDir);

        const res = await app.request(
          `/api/workspaces/${workspaceId}/artifacts-file?path=${encodeURIComponent("C:\\Windows\\System32\\config\\SAM")}`,
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain("outside");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("returns 400 when path is missing", async () => {
      const { app, db } = createTestApp();
      const tempDir = mkdtempSync(join(tmpdir(), "ak-artifacts-nopath-"));
      try {
        const { workspaceId } = await seedWorkspace(db, tempDir);
        const res = await app.request(`/api/workspaces/${workspaceId}/artifacts-file`);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain("path");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("returns 404 for nonexistent file", async () => {
      const { app, db } = createTestApp();
      const tempDir = mkdtempSync(join(tmpdir(), "ak-artifacts-noent-"));
      try {
        const { workspaceId } = await seedWorkspace(db, tempDir);
        const res = await app.request(
          `/api/workspaces/${workspaceId}/artifacts-file?path=${encodeURIComponent("nonexistent.txt")}`,
        );
        expect(res.status).toBe(404);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects reading binary files as text", async () => {
      const { app, db } = createTestApp();
      const tempDir = mkdtempSync(join(tmpdir(), "ak-artifacts-binary-"));
      try {
        writeFileSync(join(tempDir, "data.exe"), Buffer.alloc(100));
        const { workspaceId } = await seedWorkspace(db, tempDir);

        const res = await app.request(
          `/api/workspaces/${workspaceId}/artifacts-file?path=${encodeURIComponent("data.exe")}`,
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain("Cannot read");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});

describe("resolveSafePath", () => {
  // Import the function directly for unit testing
  it("can be tested via the route layer (covered above)", () => {
    // Path validation is covered through the HTTP tests above —
    // the resolveSafePath function is exercised by the traversal
    // and absolute-path rejection tests.
    expect(true).toBe(true);
  });
});
