// @covers project-registration.unified.create-project [workflow]
//
// #44: #43 unified THREE registration paths behind `scaffoldAndPopulateProject`
// (scaffold → populateDerivedProjectConfig → commit). It missed the FOURTH:
// `createProject` in project.service.ts (`POST /api/projects/create` — the "create a new
// project" flow that mkdir+`git init`s a fresh repo). It still hand-rolled the six-call
// ensure*/commit chain AND called NO populate* at all, so a project born here had:
//   - setup_script = null → no dependency install in its worktrees (#37/#810),
//   - verify_script = null → the #788 auto-merge quality gate never live,
//   - no stack profile → the ONE descriptor the harness reads (#786) simply absent.
//
// These tests lock in that createProject now routes through the SAME shared step, and that
// it does so WITHOUT an LLM call: unlike every other entry point, createProject owns the
// directory (it refuses a pre-existing path and git-inits an empty one), so the repo is
// provably empty at population time and the gap-fill would be inventing, not detecting.

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Swap the global db for a fresh in-memory libsql db. createProject takes an explicit
// `database`, but the shared step's repository calls default-arg through `db`.
// Mirrors registration-unified-path.test.ts.
vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return {
    db,
    writeDb: db,
    rawClient: undefined,
    rawWriteClient: undefined,
    schema: schemaMod,
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: { transaction: (fn: unknown) => Promise<T> }, fn: unknown) =>
      database.transaction(fn),
  };
});

// HARD guard against the real-LLM hazard, and the assertion instrument for "no ~30s LLM call
// on this HTTP path": enrichWithLlm → invokeClaudePrompt spawns a real `claude` subprocess with
// a 30s timeout. A sparse profile is EXACTLY what an empty repo produces, so without skipLlm
// this path would reach it on every project creation. Make it throw so a regression is loud.
// vi.hoisted: the vi.mock factories are hoisted above these declarations.
const { invokeClaudePrompt, populateStackProfileSpy } = vi.hoisted(() => ({
  invokeClaudePrompt: vi.fn(async (): Promise<string> => {
    throw new Error("invokeClaudePrompt must not be reached from createProject");
  }),
  // Spy on populateStackProfile so we can assert the OPTIONS createProject's shared step
  // passes, rather than inferring the design from timing (which would be flaky).
  populateStackProfileSpy: vi.fn(),
}));

vi.mock("../services/claude-cli.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/claude-cli.service.js")>()),
  invokeClaudePrompt,
}));
vi.mock("../services/stack-profile.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/stack-profile.service.js")>();
  return {
    ...actual,
    populateStackProfile: (...args: Parameters<typeof actual.populateStackProfile>) => {
      populateStackProfileSpy(...args);
      return actual.populateStackProfile(...args);
    },
  };
});

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { projects, agentSkills } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import { createProjectService } from "../services/project.service.js";
import { setPreference, getPreference } from "../repositories/preferences.repository.js";
import { verifyScriptPrefKey, getStackProfile } from "../services/stack-profile.service.js";
import { GENERIC_AGENT_GITIGNORE } from "../services/project-scaffold.js";

const dirs: string[] = [];

/** A base directory for `createProject` to mkdir a brand-new project inside. */
function makeBaseDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kanban-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** Create a project the way `POST /api/projects/create` does: name + a not-yet-existing path. */
async function createFreshProject(
  prefix: string,
  body: Partial<Parameters<ReturnType<typeof createProjectService>["createProject"]>[0]> = {},
) {
  const targetPath = join(makeBaseDir(prefix), "app");
  const service = createProjectService({ database: db });
  const result = await service.createProject({ name: `p-${prefix}`, path: targetPath, ...body });
  return { result, repoPath: targetPath };
}

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe", windowsHide: true });

describe("createProject — the FOURTH registration path now routes through the shared step (#44)", () => {
  beforeAll(async () => {
    await db.insert(agentSkills).values({
      id: randomUUID(),
      name: "board-navigator",
      description: "How to use the board",
      prompt: "use the board",
      isBuiltin: true,
      type: "skill",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // createProject's skill export is opt-in via this pref; keep it off so these tests
    // observe the scaffold/populate step, not the export.
    await setPreference("export_skills_on_registration", "false", db);
  });

  beforeEach(() => {
    invokeClaudePrompt.mockClear();
    populateStackProfileSpy.mockClear();
  });

  afterAll(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  it("POPULATES the derived config — this path previously called NO populate* at all", async () => {
    const { result, repoPath } = await createFreshProject("create-populate");

    // The stack profile (#786) is the ONE descriptor the feedback harness reads. Before #44
    // createProject never called populateStackProfile, so this key did not exist — the
    // project was born without a profile and nothing backfilled it.
    const profile = await getStackProfile(result.id, db);
    expect(profile, "createProject must persist a stack profile").not.toBeNull();
    expect(profile?.source, "rule-based, never an LLM guess").toBe("detected");

    // The population step ran, and ran with the options the shared step owns:
    // `scaffold: true` (registration is the ONE path that may materialize the profile-derived
    // scaffolds, because it also commits them — #41) and `skipLlm: true` (see below).
    expect(populateStackProfileSpy).toHaveBeenCalled();
    const [profileArgId, profileArgRepo, , profileArgOptions] = populateStackProfileSpy.mock.calls[0];
    expect(profileArgId).toBe(result.id);
    expect(existsSync(join(profileArgRepo as string, ".git")), repoPath).toBe(true);
    expect(profileArgOptions).toEqual({ skipLlm: true, scaffold: true });
  });

  it("derives NOTHING it cannot see: an empty repo yields a null profile, not an invented one", async () => {
    const { result } = await createFreshProject("create-empty");

    // createProject OWNS the directory — it refuses a pre-existing path and git-inits an empty
    // one — so at population time the repo holds nothing but the board's own scaffold. There is
    // genuinely no stack to detect, and the honest answer is null, not a guess. An INVENTED
    // setup_script would be strictly worse than null: it is executed in every worktree, so a
    // guessed `npm install` fails on what the user then builds as a Python project.
    const profile = await getStackProfile(result.id, db);
    expect(profile?.stack).toBeNull();
    expect(profile?.detectedMarkers).toEqual([]);

    const [row] = await db.select().from(projects).where(eq(projects.id, result.id));
    expect(row.setupScript, "nothing detectable ⇒ nothing invented").toBeNull();
    expect(await getPreference(verifyScriptPrefKey(result.id), db)).toBeFalsy();
  });

  it("DOES derive setup_script + the verify gate as soon as the repo has markers", async () => {
    // The empty-repo case above proves honesty but not wiring — "null in, null out" would pass
    // even if the populate calls were still missing. Seed a package.json into the fresh repo
    // between `git init` and population, exactly where a template/starter would put it, and the
    // SAME createProject call must now land the derived config the old code never produced.
    const service = createProjectService({ database: db });
    const targetPath = join(makeBaseDir("create-node"), "app");

    populateStackProfileSpy.mockImplementationOnce(() => {
      // Runs inside the shared step, after `git init` + the ensure* chain, before detection.
      writeFileSync(
        join(targetPath, "package.json"),
        JSON.stringify({ name: "toy", scripts: { test: "node --test", build: "tsc" } }),
      );
    });

    const result = await service.createProject({ name: "p-create-node", path: targetPath });

    // setup_script (#810) — without it the first worktree installs no deps (the #37 failure).
    const [row] = await db.select().from(projects).where(eq(projects.id, result.id));
    expect(row.setupScript).toBe("npm install");

    // verify/merge-gate command (#788) — the keystone auto-merge gate must be live.
    const verify = await getPreference(verifyScriptPrefKey(result.id), db);
    expect(verify).toContain("npm test");

    expect((await getStackProfile(result.id, db))?.stack).toBe("node");
    expect(invokeClaudePrompt).not.toHaveBeenCalled();
  });

  it("still scaffolds every artifact the hand-rolled chain wrote, and leaves no tracked file dirty", async () => {
    const { repoPath } = await createFreshProject("create-scaffold", { gitignoreTemplate: "node" });

    // The ensure* chain the shared step now owns — same six writes, no longer duplicated.
    const gitignore = readFileSync(join(repoPath, ".gitignore"), "utf8");
    for (const line of GENERIC_AGENT_GITIGNORE) expect(gitignore).toContain(line);
    expect(gitignore, "the chosen language template is still seeded").toContain("node_modules/");
    expect(existsSync(join(repoPath, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(repoPath, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(repoPath, ".claude", "hooks", "vital-files.json"))).toBe(true);
    expect(existsSync(join(repoPath, ".claude", "hooks", "verify-gate.config.json"))).toBe(true);

    // ...plus a PROFILE-DERIVED scaffold the old hand-rolled chain could never write: it
    // committed before any profile existed, so `.claude/smart-hooks-rules.json` (#787) was
    // simply never produced on this path.
    expect(existsSync(join(repoPath, ".claude", "smart-hooks-rules.json"))).toBe(true);

    // The shared step still runs `commitProjectScaffoldArtifacts` LAST, and it still MODIFIES
    // nothing that is already tracked — the #38 invariant (ensureBuildableFromClean records its
    // package.json/pnpm-workspace.yaml rewrites; the commit consumes the record in the same
    // process) is preserved by delegating rather than re-implementing.
    const status = git(repoPath, "status", "--porcelain", "--untracked-files=all");
    const entries = status.split("\n").filter(Boolean);
    expect(
      entries.filter((l) => !l.startsWith("??")),
      "no tracked file may be left modified/staged",
    ).toEqual([]);

    // #47 (was a characterization of the unborn-HEAD gap recorded by #44): `git init` leaves
    // HEAD unborn, so commitProjectScaffoldArtifacts threw into its non-fatal catch and the
    // scaffold stayed untracked forever. createProject now lands an initial commit first, so
    // HEAD is born and the scaffold gets its OWN commit — the same shape registerProject
    // produces — instead of being swept into the first agent's feature commit.
    expect(() => git(repoPath, "rev-parse", "HEAD")).not.toThrow();
    const tracked = git(repoPath, "ls-files").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const path of [".gitignore", "CLAUDE.md", "AGENTS.md", ".claude/hooks/vital-files.json"]) {
      expect(tracked, `${path} must be committed, not left for the first agent's git add -A`)
        .toContain(path);
    }
  });

  it("makes NO ~30s LLM call — an empty repo is sparse, which is exactly the gap-fill trigger", async () => {
    // This is the wrinkle #44 called out. An empty repo's profile is ALWAYS sparse
    // (isProfileSparse: no stack), so the default `skipLlm: false` would hand
    // `enrichWithLlm` a prompt whose only evidence is "Detected marker files: none / Repo root
    // entries: <the board's own scaffold>" — and block a real `claude` subprocess behind it.
    // The spy above throws if reached; assert it was never called at all.
    const { result } = await createFreshProject("create-nollm");

    expect(invokeClaudePrompt).not.toHaveBeenCalled();

    // Every populateStackProfile call on this path is rule-based. In particular there is no
    // SECOND, backgrounded enrichment pass — populateDerivedProjectConfig returns
    // `enrichment: null` under skipLlm. That matters beyond cost: per #41 a backgrounded pass
    // settles AFTER the scaffold commit, so skipLlm makes "async re-dirty of the checkout"
    // unreachable here rather than merely defused by `enrichmentScaffold = scaffold && await`.
    for (const call of populateStackProfileSpy.mock.calls) {
      expect(call[3]).toMatchObject({ skipLlm: true });
    }
    expect(populateStackProfileSpy).toHaveBeenCalledTimes(1);
    expect(await getStackProfile(result.id, db)).not.toBeNull();
  });
});
