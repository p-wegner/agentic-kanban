// @covers project-registration.stackProfile.readIsPure [correctness,regression]
//
// #41: `GET /api/projects/:id/stack-profile` is a READ, but it lazily calls
// populateStackProfile, and saveStackProfile (stack-profile/persistence.ts) had filesystem
// write side effects on the USER'S repo: writeSmartHooksRules + writeTestScaffold. Observed on a
// real drive: a plain GET wrote `tests/scaffold.test.js` and `.claude/smart-hooks-rules.json`
// into the project's main checkout (mtimes matched the request to the second). Both landed
// UNTRACKED, where an agent's end-of-task `git add -A` sweeps them into the project's history.
//
// The fix gates those writes behind an explicit `{ scaffold: true }`, DEFAULT OFF, so profile
// detection/persistence is pure w.r.t. the user's tree; only registration opts in (and it
// commits what it wrote). These tests lock in BOTH directions: the default writes nothing, and
// the opt-in still materializes the scaffolds — otherwise "default off" would silently become
// "never on" and a registered project would lose its feedback harness.

import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// HARD guard against the real-LLM hazard: enrichWithLlm → invokeClaudePrompt spawns a real
// `claude` subprocess with a 30s timeout. Every fixture here is a NON-sparse node repo, so the
// gap-fill must never be considered; the spy proves it and fails loudly if that ever changes.
const invokeClaudePrompt = vi.fn(async (): Promise<string> => {
  throw new Error("invokeClaudePrompt must not be reached from a stack-profile read");
});
vi.mock("../services/claude-cli.service.js", () => ({
  invokeClaudePrompt: (...args: unknown[]) => invokeClaudePrompt(...args),
}));

import { randomUUID } from "node:crypto";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { populateStackProfile, getStackProfile } from "../services/stack-profile.service.js";
import { createProjectStackProfileRoute } from "../routes/project-stack-profile.js";

/** Every file in the repo, repo-relative, so "wrote nothing" is asserted on the WHOLE tree
 *  rather than on the two paths we happen to remember today. */
function listTree(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTree(root, full));
    else out.push(relative(root, full).split("\\").join("/"));
  }
  return out.sort();
}

describe("stack-profile reads are PURE w.r.t. the user's repo (#41)", () => {
  let dir: string;
  let database: ReturnType<typeof createTestDb>["db"];
  let projectId: string;

  beforeEach(async () => {
    invokeClaudePrompt.mockClear();
    dir = mkdtempSync(join(tmpdir(), "kanban-profile-pure-"));
    // A NON-sparse node repo: stack + test + build, so no LLM gap-fill is ever considered,
    // and the profile is rich enough that the scaffolds WOULD be derivable.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "toy", scripts: { test: "node --test", build: "tsc" } }),
    );
    database = createTestDb().db;
    projectId = randomUUID();
    await database.insert(projects).values({
      id: projectId,
      name: "toy",
      repoPath: dir,
      repoName: "toy",
      defaultBranch: "main",
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("populateStackProfile at its DEFAULT writes NO files into the repo", async () => {
    const before = listTree(dir);

    const profile = await populateStackProfile(projectId, dir, database);

    // The profile itself is still computed and PERSISTED — purity is about the user's tree,
    // not about doing nothing.
    expect(profile.stack).toBe("node");
    expect((await getStackProfile(projectId, database))?.stack).toBe("node");

    expect(listTree(dir), "a profile read must not touch the user's working tree").toEqual(before);
    expect(invokeClaudePrompt).not.toHaveBeenCalled();
  });

  it("GET /api/projects/:id/stack-profile writes NO files into the repo — the core regression", async () => {
    const before = listTree(dir);

    const router = createProjectStackProfileRoute(database);
    const res = await router.request(`/${projectId}/stack-profile`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { profile: { stack: string | null } };
    expect(body.profile.stack).toBe("node");

    // The exact bug: `?? tests/scaffold.test.js` and `?? .claude/smart-hooks-rules.json`
    // appearing in the user's main checkout because someone asked what stack it was.
    expect(listTree(dir), "a GET must not mutate the user's working tree").toEqual(before);
  });

  it("?refresh=true — a forced recompute is a read too, and still writes nothing", async () => {
    const before = listTree(dir);
    const router = createProjectStackProfileRoute(database);

    await router.request(`/${projectId}/stack-profile`);
    const res = await router.request(`/${projectId}/stack-profile?refresh=true`);

    expect(res.status).toBe(200);
    expect(listTree(dir)).toEqual(before);
  });

  it("PUT /api/projects/:id/stack-profile persists the override without scaffolding", async () => {
    const before = listTree(dir);
    const router = createProjectStackProfileRoute(database);

    const res = await router.request(`/${projectId}/stack-profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ testCommand: "npm run test:unit" }),
    });

    expect(res.status).toBe(200);
    // The override IS persisted…
    const saved = await getStackProfile(projectId, database);
    expect(saved?.testCommand).toBe("npm run test:unit");
    expect(saved?.source).toBe("manual");
    // …but `.claude/smart-hooks-rules.json` is TRACKED once registration committed it, so
    // regenerating it here would leave a MODIFIED tracked file in the user's main checkout —
    // which is what actually trips the `dirty_main` auto-merge block.
    expect(listTree(dir)).toEqual(before);
  });

  it("OPT-IN still works: { scaffold: true } materializes the profile-derived scaffolds", async () => {
    // The other direction — without this, "default off" could quietly become "never on" and a
    // freshly-registered project would silently lose its edit-time feedback harness.
    await populateStackProfile(projectId, dir, database, { skipLlm: true, scaffold: true });

    const tree = listTree(dir);
    expect(tree).toContain(".claude/smart-hooks-rules.json");
    expect(tree.some((p) => p.startsWith("tests/"))).toBe(true);
  });
});
