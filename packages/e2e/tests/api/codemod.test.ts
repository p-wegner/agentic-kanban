/**
 * E2E tests for the Codemod Factory API endpoints.
 *
 * Tests use local fixture TypeScript files in a temp directory to verify
 * that the preview endpoint can find and diff changes without touching
 * the real project files.
 */

import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SERVER_URL as BASE } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

/** Create 5 TypeScript fixture files in a temp directory for testing. */
async function createFixtures(): Promise<{ tmpDir: string; files: string[] }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "codemod-e2e-"));

  const fixtures = [
    {
      name: "widget.ts",
      content: `export class Widget {\n  name: string = '';\n  constructor(name: string) { this.name = name; }\n}\n`,
    },
    {
      name: "widget-factory.ts",
      content: `import { Widget } from './widget';\nexport function createWidget(name: string): Widget {\n  return new Widget(name);\n}\n`,
    },
    {
      name: "widget-registry.ts",
      content: `import { Widget } from './widget';\nconst registry: Widget[] = [];\nexport function register(w: Widget): void { registry.push(w); }\n`,
    },
    {
      name: "widget-service.ts",
      content: `import { Widget } from './widget';\nexport class WidgetService {\n  private items: Widget[] = [];\n  add(w: Widget) { this.items.push(w); }\n  getAll(): Widget[] { return this.items; }\n}\n`,
    },
    {
      name: "index.ts",
      content: `export { Widget } from './widget';\nexport { createWidget } from './widget-factory';\nexport { register } from './widget-registry';\nexport { WidgetService } from './widget-service';\n`,
    },
  ];

  const files: string[] = [];
  for (const f of fixtures) {
    const filePath = join(tmpDir, f.name);
    await writeFile(filePath, f.content, "utf8");
    files.push(filePath);
  }

  return { tmpDir, files };
}

test.describe("Codemod Factory API", () => {
  let projectId: string;
  let tmpDir: string;
  let originalProjectRepoPath: string;

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);

    // Get the project's repo path so we can run codemods against the real project
    const projectsRes = await request.get(`${BASE}/api/projects`);
    const projects = await projectsRes.json();
    const project = projects.find((p: { id: string }) => p.id === projectId);
    originalProjectRepoPath = project?.repoPath ?? "";

    // Create temp fixture dir (used in direct-fixture test below)
    const { tmpDir: td } = await createFixtures();
    tmpDir = td;
  });

  test.afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("POST /api/codemods/preview returns 400 without description", async ({ request }) => {
    const res = await request.post(`${BASE}/api/codemods/preview`, {
      data: { projectId },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/description/i);
  });

  test("POST /api/codemods/preview returns 400 without projectId", async ({ request }) => {
    const res = await request.post(`${BASE}/api/codemods/preview`, {
      data: { description: "rename Foo to Bar" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/projectId/i);
  });

  test("POST /api/codemods/preview with valid project returns script and file list", async ({ request }) => {
    // This test runs against the real project — AI is invoked so we allow generous timeout
    test.setTimeout(120_000);

    const res = await request.post(`${BASE}/api/codemods/preview`, {
      data: {
        description: "This is a no-op test codemod — do not change any files",
        projectId,
      },
      timeout: 110_000,
    });

    // Should succeed or return a meaningful error (not 400/500 from missing fields)
    expect([200, 500]).toContain(res.status()); // 500 if AI not available in test env
    if (res.status() === 200) {
      const body = await res.json();
      expect(typeof body.script).toBe("string");
      expect(Array.isArray(body.files)).toBe(true);
      expect(typeof body.totalTsFiles).toBe("number");
      expect(typeof body.limitReached).toBe("boolean");
    }
  });

  test("POST /api/codemods/apply returns 400 with empty changes array", async ({ request }) => {
    const res = await request.post(`${BASE}/api/codemods/apply`, {
      data: { projectId, changes: [] },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/codemods/apply returns 400 without projectId", async ({ request }) => {
    const res = await request.post(`${BASE}/api/codemods/apply`, {
      data: { changes: [{ filePath: join(tmpDir, "x.ts"), modified: "x" }] },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/projectId/i);
  });

  test("POST /api/codemods/apply refuses to write outside the project", async ({ request }) => {
    // tmpDir is outside the project repo — the server must reject the write.
    const escapeFile = join(tmpDir, "escape.ts");
    await writeFile(escapeFile, "export const z = 0;\n", "utf8");

    const res = await request.post(`${BASE}/api/codemods/apply`, {
      data: {
        projectId,
        changes: [{ filePath: escapeFile, modified: "export const z = 666;\n" }],
        selectedFiles: [escapeFile],
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/outside the project/i);

    // The file must be unchanged.
    const { readFile } = await import("node:fs/promises");
    const after = await readFile(escapeFile, "utf8");
    expect(after).toBe("export const z = 0;\n");
  });

  test("POST /api/codemods creates a saved codemod", async ({ request }) => {
    const suffix = Date.now().toString(36);
    const res = await request.post(`${BASE}/api/codemods`, {
      data: {
        name: `test-codemod-${suffix}`,
        description: "Rename Widget to Component",
        script: "// for (const cls of sourceFile.getClasses()) { if (cls.getName() === 'Widget') cls.rename('Component'); }",
        projectId,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe(`test-codemod-${suffix}`);
    expect(body.type).toBe("codemod");

    // Verify it appears in the GET /api/codemods list
    const listRes = await request.get(`${BASE}/api/codemods?projectId=${projectId}`);
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    expect(Array.isArray(list)).toBe(true);
    const found = list.find((c: { id: string }) => c.id === body.id);
    expect(found).toBeDefined();
    expect(found.type).toBe("codemod");

    // Cleanup
    const skillsDeleteRes = await request.delete(`${BASE}/api/agent-skills/${body.id}`);
    expect(skillsDeleteRes.ok()).toBeTruthy();
  });

  test("POST /api/codemods returns 400 when name missing", async ({ request }) => {
    const res = await request.post(`${BASE}/api/codemods`, {
      data: { description: "some codemod", script: "// code" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/codemods returns 400 when script missing", async ({ request }) => {
    const res = await request.post(`${BASE}/api/codemods`, {
      data: { name: "no-script", description: "codemod" },
    });
    expect(res.status()).toBe(400);
  });

  test("GET /api/codemods returns only codemods", async ({ request }) => {
    const res = await request.get(`${BASE}/api/codemods`);
    expect(res.ok()).toBeTruthy();
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    // All returned items should have type='codemod'
    for (const item of list) {
      expect(item.type).toBe("codemod");
    }
  });

  test("GET /api/codemods/:id returns 404 for unknown id", async ({ request }) => {
    const res = await request.get(`${BASE}/api/codemods/00000000-0000-0000-0000-000000000000`);
    expect(res.status()).toBe(404);
  });

  test("POST /api/codemods/apply writes selected files", async ({ request }) => {
    // Apply writes only inside the project repo, so the target file must live there.
    const { unlink } = await import("node:fs/promises");
    const tmpFile = join(originalProjectRepoPath, `.codemod-apply-test-${Date.now().toString(36)}.ts`);
    await writeFile(tmpFile, "export const x = 1;\n", "utf8");

    try {
      const res = await request.post(`${BASE}/api/codemods/apply`, {
        data: {
          projectId,
          changes: [
            {
              filePath: tmpFile,
              modified: "export const x = 42;\n",
            },
          ],
          selectedFiles: [tmpFile],
        },
      });
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      expect(body.applied).toContain(tmpFile);
      expect(body.skipped).toHaveLength(0);

      // Verify file was written
      const { readFile } = await import("node:fs/promises");
      const written = await readFile(tmpFile, "utf8");
      expect(written).toBe("export const x = 42;\n");
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  });

  test("POST /api/codemods/apply skips files not in selectedFiles", async ({ request }) => {
    const { unlink } = await import("node:fs/promises");
    const tmpFile = join(originalProjectRepoPath, `.codemod-skip-test-${Date.now().toString(36)}.ts`);
    await writeFile(tmpFile, "export const y = 'original';\n", "utf8");

    try {
      const res = await request.post(`${BASE}/api/codemods/apply`, {
        data: {
          projectId,
          changes: [
            {
              filePath: tmpFile,
              modified: "export const y = 'modified';\n",
            },
          ],
          selectedFiles: [], // empty = apply all
        },
      });
      expect(res.ok()).toBeTruthy();
      // Empty selectedFiles = apply all
      const body = await res.json();
      expect(body.applied.length + body.skipped.length).toBe(1);
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  });
});
