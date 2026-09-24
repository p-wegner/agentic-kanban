/**
 * #1239 item 2 — a heal ticket's workspace is BASED ON THE RELEASE CANDIDATE: the worktree
 * branches from the rc, the row records the rc as its base, and the merge lands on the rc, not
 * on master. The base is resolved in one place (`workspace-base.ts`) for every path that used
 * to spell `workspace.baseBranch || defaultBranch` by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { isAncestor, mergeBranch, revParse } from "@agentic-kanban/shared/lib/git-service";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { healTicketExternalKey } from "../lib/heal-ticket-key.js";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceCrudService } from "../services/workspace-crud.service.js";
import { resolveIssueBaseBranch, resolveWorkspaceBase, resolveWorkspaceBaseOrNull } from "../services/workspace-base.js";
import { WorkspaceError } from "../services/workspace-internals.js";

const RC = "rc/20260925";

describe("resolveWorkspaceBase (#1239)", () => {
  it("prefers the workspace row's base, falls back to the project default, refuses neither", () => {
    expect(resolveWorkspaceBase({ baseBranch: RC }, { defaultBranch: "master" })).toBe(RC);
    expect(resolveWorkspaceBase({ baseBranch: null }, { defaultBranch: "master" })).toBe("master");
    expect(resolveWorkspaceBaseOrNull({ baseBranch: "" }, { defaultBranch: null })).toBeNull();
    expect(() => resolveWorkspaceBase({ baseBranch: null }, { defaultBranch: null })).toThrow(WorkspaceError);
  });

  it("an rc heal ticket's key names the base a new workspace branches from; anything else answers null", () => {
    expect(resolveIssueBaseBranch(healTicketExternalKey("p", "sig", RC))).toBe(RC);
    expect(resolveIssueBaseBranch(healTicketExternalKey("p", "sig"))).toBeNull();
    expect(resolveIssueBaseBranch("plugin-loop:x:y:z")).toBeNull();
    expect(resolveIssueBaseBranch(null)).toBeNull();
  });
});

describe("a workspace created for a heal ticket (#1239)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let createWorktree: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ db } = createTestDb());
    createWorktree = vi.fn(async (_repo: string, branch: string) => `/tmp/worktrees/${branch}`);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  async function seedIssue(externalKey: string | null) {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now });
    await db.insert(issues).values({ id: issueId, issueNumber: 7, title: "heal: rc is red", description: null, priority: "critical", sortOrder: 0, statusId, projectId, externalKey, createdAt: now, updatedAt: now });
    return issueId;
  }

  function service() {
    return createWorkspaceCrudService({
      database: db,
      getSessionManager: () => ({ startSession: vi.fn(async () => "sid"), stopSession: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }) as never,
      gitService: {
        createWorktree,
        removeWorktree: vi.fn(async () => {}),
        getCurrentBranch: vi.fn(async () => "master"),
        getHeadCommitSha: vi.fn(async () => "abc123"),
        revParse: vi.fn(async () => "abc123"),
        pruneWorktrees: vi.fn(async () => {}),
        listWorktrees: vi.fn(async () => []),
        ensureOnBranch: vi.fn(async () => {}),
      } as never,
    });
  }

  async function create(issueId: string, baseBranch?: string) {
    return service().createWorkspace({
      issueId, branch: "feature/ak-7-heal", isDirect: false, requiresReview: false, thoroughReview: false,
      planMode: false, tddMode: false, includeVisualProof: false, skipSetup: true, skipContextPacker: true, baseBranch,
    });
  }

  it("branches the worktree from the rc and records the rc as the row's base", async () => {
    const issueId = await seedIssue(healTicketExternalKey("p", "deadbeef1234", RC));
    const created = await create(issueId);
    expect(createWorktree).toHaveBeenCalledWith("/tmp/repo", "feature/ak-7-heal", RC, expect.anything());
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, created.id));
    expect(row.baseBranch).toBe(RC);
  });

  it("an explicit base still wins, and an ordinary ticket keeps the project default", async () => {
    const heal = await seedIssue(healTicketExternalKey("p", "deadbeef1234", RC));
    await create(heal, "release/1.x");
    expect(createWorktree).toHaveBeenLastCalledWith("/tmp/repo", "feature/ak-7-heal", "release/1.x", expect.anything());

    const ordinary = await seedIssue(null);
    const created = await create(ordinary);
    expect(createWorktree).toHaveBeenLastCalledWith("/tmp/repo", "feature/ak-7-heal", "master", expect.anything());
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, created.id));
    expect(row.baseBranch).toBe("master");
  });
});

describe("the heal merges into the rc, not master (temp repo)", () => {
  let repo: string;
  const git = (args: string[]) => gitExecOrThrow(args, { cwd: repo });

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "ak-heal-merge-"));
    await git(["init", "-q", "-b", "master"]);
    writeFileSync(join(repo, "a.txt"), "base\n");
    await git(["add", "."]);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"]);
    await git(["branch", RC]);
    // master moves on after the cut, as decision 019 says it may.
    writeFileSync(join(repo, "m.txt"), "master moved\n");
    await git(["add", "."]);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "master landing"]);
    // The heal, branched from the rc.
    await git(["checkout", "-q", "-b", "feature/ak-7-heal", RC]);
    writeFileSync(join(repo, "a.txt"), "healed\n");
    await git(["add", "."]);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "heal"]);
    await git(["checkout", "-q", "master"]);
  });

  afterEach(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("the target the merge path resolves for the heal workspace is the rc, and the heal lands there only", async () => {
    const target = resolveWorkspaceBase({ baseBranch: RC }, { defaultBranch: "master" });
    const masterBefore = await revParse(repo, "master");
    await mergeBranch(repo, "feature/ak-7-heal", target, { deferWorkingTreeSync: true });
    expect(await isAncestor(repo, "feature/ak-7-heal", RC)).toBe(true);
    expect(await isAncestor(repo, "feature/ak-7-heal", "master")).toBe(false);
    expect(await revParse(repo, "master")).toBe(masterBefore);
  });
});
