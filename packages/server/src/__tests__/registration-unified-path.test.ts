// @covers project-registration.unified [workflow]
//
// #43: registration was implemented THREE times — REST `POST /api/projects`
// (project.service.ts), CLI `register` (cli/commands/register.ts) and CLI `init` / `dev`
// auto-register (project-registration.ts `registerProject`). Each hand-rolled its own
// chain, so a new registration-time step had to be remembered in three places. That is
// exactly how #37 happened: #810's setup script and #788's verify script were wired into
// one path only, and the REST path never called populateSetupScript AT ALL.
//
// The fix routes every entry point through ONE shared step, `scaffoldAndPopulateProject`
// (scaffold → `populateDerivedProjectConfig` → commit). These tests lock in the ANTI-DIVERGENCE
// guarantee: both live entry points must produce an equivalent, driveable project.
//
// #42: the deterministic/rule-based population is awaited (fast + offline); the optional
// ~30s LLM gap-fill is kept OFF the hot path. Asserted here via the skipLlm semantics and
// a hard spy on invokeClaudePrompt.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Swap the global db for a fresh in-memory libsql db so registerProject() (which writes
// through the default-arg `db` of its repository functions) hits a throwaway database.
// Mirrors registration-create-workflow.test.ts.
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

// HARD guard against the real-LLM hazard: enrichWithLlm → invokeClaudePrompt spawns a real
// `claude` subprocess with a 30s timeout (it caused a real 20s timeout while writing #37's
// tests). Nothing in this file may reach it. The spy doubles as the assertion instrument for
// #42 — "no ~30s LLM call on the hot path" is checked by asserting it was never called.
// vi.hoisted: the vi.mock factories below are hoisted above these declarations, so the spies
// must be created in a hoisted block or the factory closes over an uninitialised binding.
const { invokeClaudePrompt, populateStackProfileSpy } = vi.hoisted(() => ({
  invokeClaudePrompt: vi.fn(async (): Promise<string> => {
    throw new Error("invokeClaudePrompt must not be reached from the registration hot path");
  }),
  // Spy on populateStackProfile so we can assert the OPTIONS the hot path passes it, rather
  // than inferring the design from timing (which would be flaky).
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
import { projects, projectStatuses, agentSkills } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import { registerProject, populateDerivedProjectConfig } from "../services/project-registration.js";
import { createProjectService } from "../services/project.service.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { verifyScriptPrefKey, getStackProfile } from "../services/stack-profile.service.js";
import { GENERIC_AGENT_GITIGNORE } from "../services/project-scaffold.js";

const dirs: string[] = [];

/** A real git repo with one commit. `markers` are extra files written before the commit. */
function makeGitRepo(prefix: string, markers: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), `kanban-${prefix}-`));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe", windowsHide: true });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Registration Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  for (const [name, content] of Object.entries(markers)) {
    writeFileSync(join(dir, name), content);
  }
  git("add", "-A");
  git("commit", "-m", "initial");
  return dir;
}

/**
 * A plain npm Node repo. The test+build scripts keep the rule-based profile NON-SPARSE,
 * so `populateStackProfile` never considers the LLM gap-fill — the common case, and what
 * keeps these tests hermetic and fast.
 */
function makeNodeRepo(prefix: string): string {
  return makeGitRepo(prefix, {
    "package.json": JSON.stringify({
      name: "toy",
      scripts: { test: "node --test", build: "tsc" },
    }),
  });
}

describe("registration — ONE path for every entry point (#43)", () => {
  beforeAll(async () => {
    // registerProject attaches the board-navigator skill by name; seed it so the CLI/init
    // path and the REST path can be compared on defaultSkillId.
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

  it("scaffolds the repo — the CLI init / dev auto-register path had NO scaffolding at all", async () => {
    const repo = makeNodeRepo("reg-scaffold");

    const { created } = await registerProject(repo);
    expect(created).toBe(true);

    // Agent-artifact ignores: without these, agent scratch lands in the project's history.
    const gitignore = readFileSync(join(repo, ".gitignore"), "utf8");
    for (const line of GENERIC_AGENT_GITIGNORE) expect(gitignore).toContain(line);

    // Starter working agreements — CLAUDE.md for Claude, AGENTS.md for Codex.
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);

    // Hook scaffold + verify-gate runner config.
    expect(existsSync(join(repo, ".claude", "hooks", "vital-files.json"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "hooks", "verify-gate.config.json"))).toBe(true);
  });

  it("commits every scaffold-owned artifact, incl. the package.json rewrite (#38)", async () => {
    const repo = makeNodeRepo("reg-commit");

    await registerProject(repo);

    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
    });
    const dirty = status.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);

    // #38: ensureBuildableFromClean records the non-.claude project files it rewrote
    // (package.json / pnpm-workspace.yaml) in module-level state keyed by repo path, which
    // commitProjectScaffoldArtifacts consumes. The record survives the population step (it is
    // keyed by PATH), but the commit must still run in the SAME process after it — or the
    // board's own package.json edit is left uncommitted and main goes dirty. Assert no
    // scaffold-OWNED path survives uncommitted.
    for (const owned of [".gitignore", "CLAUDE.md", "AGENTS.md", "package.json"]) {
      expect(dirty, `${owned} must be swept into the scaffold commit`).not.toContain(owned);
    }

    // #41: the profile-derived scaffolds are written BEFORE the commit now (ensure* → populate
    // → write → commit), so registration no longer leaves them untracked in the user's main
    // checkout — where an agent's end-of-task `git add -A` would sweep them into the project's
    // history. They must EXIST and be COMMITTED, not dangling.
    expect(existsSync(join(repo, ".claude", "smart-hooks-rules.json"))).toBe(true);
    expect(existsSync(join(repo, "tests", "scaffold.test.js"))).toBe(true);
    expect(dirty, "registration must leave the main checkout clean (#41)").toEqual([]);
  });

  it("ANTI-DIVERGENCE: the REST path and the register/init path produce an equivalent project", async () => {
    const viaService = makeNodeRepo("reg-equiv-a");
    const viaRest = makeNodeRepo("reg-equiv-b");

    // Path 1 — CLI `register` / `init` / `dev` auto-register.
    const { project: a } = await registerProject(viaService);
    // Path 2 — REST POST /api/projects.
    const projectService = createProjectService({ database: db });
    const b = await projectService.registerProject({ repoPath: viaRest });

    for (const [label, id, repoPath] of [
      ["register/init", a.id, viaService],
      ["REST", b.id, viaRest],
    ] as const) {
      // setup_script (#810) — without it the first worktree installs no deps. The REST path
      // never called populateSetupScript before #43, so this was null there forever.
      const [row] = await db.select().from(projects).where(eq(projects.id, id));
      expect(row.setupScript, `${label}: setup_script`).toBe("npm install");

      // verify/merge-gate command (#788) — the keystone auto-merge gate must be live.
      const verify = await getPreference(verifyScriptPrefKey(id), db);
      expect(verify, `${label}: verify pref`).toBeTruthy();
      expect(verify, `${label}: verify pref`).toContain("npm test");

      // The durable stack profile (#786) — the ONE descriptor the harness reads.
      const profile = await getStackProfile(id, db);
      expect(profile?.stack, `${label}: stack`).toBe("node");

      // Canonical 7-status set incl. Backlog(-1), so Backlog-pull auto-start works (#772).
      const statuses = await db
        .select()
        .from(projectStatuses)
        .where(eq(projectStatuses.projectId, id));
      expect(statuses.map((s) => s.name).sort(), `${label}: statuses`).toEqual(
        ["AI Reviewed", "Backlog", "Cancelled", "Done", "In Progress", "In Review", "Todo"].sort(),
      );

      // Both paths scaffold identically.
      expect(existsSync(join(repoPath, "CLAUDE.md")), `${label}: CLAUDE.md`).toBe(true);
      expect(
        existsSync(join(repoPath, ".claude", "hooks", "vital-files.json")),
        `${label}: hooks`,
      ).toBe(true);
    }

    // Both attach the same default skill — getDefaultSkillId() (CLI) and
    // getBoardNavigatorSkillId() (service) were never actually different: the former
    // delegates to the latter. Locked in so they cannot drift apart again.
    const [rowB] = await db.select().from(projects).where(eq(projects.id, b.id));
    expect(a.defaultSkillId).toBeTruthy();
    expect(rowB.defaultSkillId).toBe(a.defaultSkillId);
  });

  it("registration is non-fatal when scaffolding cannot write (project must still be driveable)", async () => {
    const repo = makeNodeRepo("reg-hostile");
    // Make every scaffold write fail: .gitignore is a DIRECTORY (writeFileSync → EISDIR) and
    // .claude is a FILE (mkdirSync → EEXIST/ENOTDIR).
    mkdirSync(join(repo, ".gitignore"));
    writeFileSync(join(repo, ".claude"), "not a directory");

    const { project, created } = await registerProject(repo);

    // Scaffolding failed, but registration succeeded — "scaffolding must never block
    // registration". The project is still fully driveable.
    expect(created).toBe(true);
    const statuses = await db
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, project.id));
    expect(statuses).toHaveLength(7);
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row.setupScript).toBe("npm install"); // derived config still landed
  });

  it("registration is non-fatal when detection/enrichment fails", async () => {
    // A repo with NO stack markers is "sparse", so enrichment is attempted — and our spy
    // makes invokeClaudePrompt throw. Registration must still succeed.
    const repo = makeGitRepo("reg-nodetect");

    const { project, created, setupScript } = await registerProject(repo, {
      awaitEnrichment: true, // surface the failure synchronously instead of backgrounding it
    });

    expect(created).toBe(true);
    expect(setupScript).toBeNull(); // nothing detectable, nothing invented
    const statuses = await db
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, project.id));
    expect(statuses).toHaveLength(7);
  });
});

describe("registration — the LLM gap-fill stays OFF the hot path (#42)", () => {
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

  it("awaits the rule-based pass with skipLlm — the awaited work is offline and fast", async () => {
    const repo = makeNodeRepo("reg-skiplllm");
    const id = randomUUID();

    await populateDerivedProjectConfig(id, repo, db);

    // The FIRST (awaited) populateStackProfile call must be rule-based-only. This is what
    // lets both entry points await population without a caller ever blocking ~30s on an LLM.
    expect(populateStackProfileSpy).toHaveBeenCalled();
    const firstCallOptions = populateStackProfileSpy.mock.calls[0][3];
    expect(firstCallOptions).toEqual({ skipLlm: true });
    expect(invokeClaudePrompt).not.toHaveBeenCalled();
  });

  it("schedules NO enrichment for a repo whose markers are sufficient (the common case)", async () => {
    const repo = makeNodeRepo("reg-nonsparse");
    const id = randomUUID();

    const { enrichment, setupScript } = await populateDerivedProjectConfig(id, repo, db);

    // A repo with test+build scripts is not sparse — the LLM is never in the picture at all.
    expect(enrichment).toBeNull();
    expect(setupScript).toBe("npm install");
    expect(invokeClaudePrompt).not.toHaveBeenCalled();
  });

  it("DEFERS enrichment for a sparse repo instead of inlining it into the awaited path", async () => {
    const repo = makeGitRepo("reg-sparse"); // no markers → sparse → enrichment is warranted
    const id = randomUUID();

    // Fake a successful gap-fill so we can observe the deferred pass end-to-end without a
    // real 30s `claude` call.
    invokeClaudePrompt.mockImplementation(async () =>
      JSON.stringify({ stack: "node", packageManager: "npm", testCommand: "npm test", buildCommand: "npm run build" }),
    );

    const { enrichment } = await populateDerivedProjectConfig(id, repo, db);

    // The awaited part returned WITHOUT the LLM having produced the result — enrichment is a
    // separate promise the caller may background (server) or await (short-lived CLI).
    expect(enrichment).not.toBeNull();

    // Awaiting it deterministically (rather than racing a detached promise) shows it does run.
    await enrichment;
    const profile = await getStackProfile(id, db);
    expect(profile?.stack).toBe("node");
    expect(invokeClaudePrompt).toHaveBeenCalled();
  });

  it("skipLlm suppresses enrichment entirely", async () => {
    const repo = makeGitRepo("reg-skip");
    const id = randomUUID();

    const { enrichment, setupScript } = await populateDerivedProjectConfig(id, repo, db, {
      skipLlm: true,
    });

    expect(enrichment).toBeNull();
    expect(setupScript).toBeNull();
    expect(invokeClaudePrompt).not.toHaveBeenCalled();
  });
});
