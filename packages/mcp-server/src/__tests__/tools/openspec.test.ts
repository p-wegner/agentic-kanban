import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import {
  registerOpenSpecListSpecs,
  registerShowSpec,
  registerValidateChange,
} from "../../tools/openspec.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedProject } from "../helpers/seed.js";

const tempDirs: string[] = [];

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ak-openspec-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("OpenSpec MCP tools", () => {
  it("lists and shows living specs", async () => {
    const repoPath = await tempRepo();
    await mkdir(join(repoPath, "openspec", "specs", "butler-context"), { recursive: true });
    await writeFile(join(repoPath, "openspec", "specs", "butler-context", "spec.md"), "# butler-context\n", "utf-8");

    const listSetup = setupTool(registerOpenSpecListSpecs);
    const { projectId } = await seedProject(listSetup.db);
    await listSetup.db.update(schema.projects).set({ repoPath }).where(eq(schema.projects.id, projectId));

    const listed = parseResult(await listSetup.invoke({ projectId }));
    expect(listed.specs).toEqual([{ domain: "butler-context", path: "openspec/specs/butler-context/spec.md" }]);

    const showSetup = setupTool(registerShowSpec);
    const { projectId: projectId2 } = await seedProject(showSetup.db);
    await showSetup.db.update(schema.projects).set({ repoPath }).where(eq(schema.projects.id, projectId2));

    const shown = parseResult(await showSetup.invoke({ projectId: projectId2, domain: "butler-context" }));
    expect(shown.content).toContain("# butler-context");
  });

  it("validates deltas and warns on same-domain collisions", async () => {
    const repoPath = await tempRepo();
    await mkdir(join(repoPath, "openspec", "changes", "a", "specs", "merge"), { recursive: true });
    await mkdir(join(repoPath, "openspec", "changes", "b", "specs", "merge"), { recursive: true });
    await writeFile(join(repoPath, "openspec", "changes", "a", "specs", "merge", "spec.md"), "## ADDED\n\n### Requirement A\n\nA\n", "utf-8");
    await writeFile(join(repoPath, "openspec", "changes", "b", "specs", "merge", "spec.md"), "## MODIFIED\n\n### Requirement B\n\nB\n", "utf-8");

    const setup = setupTool(registerValidateChange);
    const { projectId } = await seedProject(setup.db);
    await setup.db.update(schema.projects).set({ repoPath }).where(eq(schema.projects.id, projectId));

    const result = parseResult(await setup.invoke({ projectId }));
    expect(result.valid).toBe(true);
    expect(result.deltas).toHaveLength(2);
    expect(result.warnings[0]).toContain("Multiple deltas touch 'merge'");
  });
});
