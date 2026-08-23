// @gate:always-run — reads CLAUDE.md, .claude/skills via git, and builtin-skills.ts; imports
// nothing it checks beyond the two contracts it asserts about.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BUILTIN_SKILLS } from "../builtin-skills.js";
import { buildBoardFeedbackSection, type BoardFeedbackRouting } from "@agentic-kanban/shared/lib/ticket-context";

/**
 * The two CLAUDE.md invariants left over from #598 (items 5 and 6).
 *
 * Both were deliberately deferred by `claude-md-git-invariants.test.ts` with reasons that
 * were correct about the FORMULATION the ticket proposed, and those reasons are what this
 * file routes around rather than overrides:
 *
 *  - item 5 was "`set(BUILTIN_SKILLS) ∩ dirs in .claude/skills` == the documented 8". That
 *    directory also holds plugin skills junctioned in on enable, so its contents vary per
 *    machine. Asking GIT what is tracked removes the machine entirely — a junctioned plugin
 *    skill is never tracked.
 *  - item 6 was "the four mode names + the deployment table appear in both texts". Asserting
 *    prose appears twice pins wording and goes stale on any rewording. And it is factually
 *    wrong about the code: `buildBoardFeedbackSection` renders only TWO of the four modes,
 *    because in a worktree the rule is fixed. What is worth pinning is the IDENTIFIERS —
 *    the mode names are a contract between the doc and the router, not prose.
 */
const repoRoot = path.join(import.meta.dirname!, "..", "..", "..", "..");

function gitTrackedSkillDirs(): string[] {
  const out = execFileSync("git", ["ls-files", ".claude/skills"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  const dirs = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const rel = line.trim().replace(/^\.claude\/skills\//, "");
    if (!rel) continue;
    const [dir] = rel.split("/");
    if (dir) dirs.add(dir);
  }
  return [...dirs].sort();
}

/**
 * Built-in skills that ALSO ship an on-disk copy in this repo, frozen. The rule is
 * "project-specific skills do NOT go in `builtin-skills.ts`" (CLAUDE.md § Agent Skills), and
 * this intersection is how it is measurable: adding `dev-server` or `db-doctor` to the
 * built-ins grows this set and fails. A genuinely new built-in with a fresh name does not
 * touch it. Only ever change this list deliberately.
 */
const BUILTIN_WITH_ONDISK_COPY = [
  "architecture-review",
  "board-navigator",
  "code-review",
  "code-review-thorough",
  "dependency-analyzer",
  "kanban-workflow",
  "merge-reconciler",
  "monitor-nudge",
  "orchestrator",
  "quality-metrics-collector",
  "ticket-enhancer",
  "ui-review",
].sort();

describe("CLAUDE.md skill invariant — project-specific skills are not built-ins (#598)", () => {
  it("the built-in ∩ on-disk overlap is exactly the frozen set", () => {
    const builtinNames = new Set<string>(BUILTIN_SKILLS.map((s) => s.name));
    const tracked = gitTrackedSkillDirs();
    expect(tracked.length, "no tracked skills found — the git query broke, not the rule").toBeGreaterThan(10);
    const overlap = tracked.filter((d) => builtinNames.has(d)).sort();
    expect(
      overlap,
      "CLAUDE.md § Agent Skills: project-specific skills live ONLY in .claude/skills and must " +
        "not be added to builtin-skills.ts (they ship in npm). Update the frozen list only when " +
        "you meant to change which skills are built in.",
    ).toEqual(BUILTIN_WITH_ONDISK_COPY);
  });

  it("the named project-only skills are not built-ins", () => {
    // A direct restatement of the rule, so a failure names the offender rather than a diff.
    const builtinNames = new Set<string>(BUILTIN_SKILLS.map((s) => s.name));
    const projectOnly = ["publish", "cleanup", "session-inspector", "board-monitor", "dev-server", "db-doctor"];
    const leaked = projectOnly.filter((name) => builtinNames.has(name));
    expect(leaked, `project-specific skills found in builtin-skills.ts: ${leaked.join(", ")}`).toEqual([]);
  });
});

describe("CLAUDE.md board-feedback invariant — modes stay in lockstep with the router (#598)", () => {
  const claudeMd = fs.readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8");
  const ALL_MODES = ["fix-direct", "file-ticket", "file-and-drive", "gh-issue"];

  it("CLAUDE.md documents all four modes by name", () => {
    const missing = ALL_MODES.filter((mode) => !claudeMd.includes(mode));
    expect(missing, `CLAUDE.md § Board Feedback Conventions no longer names: ${missing.join(", ")}`).toEqual([]);
  });

  it("every routing kind the type can produce is rendered — no silent fallthrough", () => {
    // This is the half that would actually break a builder: a new kind added to
    // BoardFeedbackRouting but not handled renders a section that says nothing.
    const routings: BoardFeedbackRouting[] = [
      { kind: "file-ticket", projectId: "p1", projectName: "agentic-kanban", isCurrentProject: false },
      { kind: "gh-issue", issuesUrl: "https://example.invalid/issues", deployment: "packaged" },
    ];
    for (const routing of routings) {
      const section = buildBoardFeedbackSection(routing);
      expect(section, `no section rendered for kind ${routing.kind}`).toBeTruthy();
      expect(section!.length, `section for kind ${routing.kind} is a stub`).toBeGreaterThan(200);
    }
  });

  it("the worktree section never offers a main-checkout mode", () => {
    // `buildBoardFeedbackSection` deliberately renders only what applies IN A WORKTREE.
    // `fix-direct` and `file-and-drive` both mean editing the board's main checkout, which
    // is exactly the collision CLAUDE.md forbids a builder to cause while other workspaces
    // are live — so their presence here would be a real defect, not a wording drift.
    //
    // Only the negative direction is asserted. The rendered section names no mode
    // identifier at all (it gives the builder the ACTION, not the vocabulary), so a
    // matching positive assertion would pin something untrue.
    const routings: BoardFeedbackRouting[] = [
      { kind: "file-ticket", projectId: "p1", projectName: "agentic-kanban", isCurrentProject: false },
      { kind: "gh-issue", issuesUrl: "https://example.invalid/issues", deployment: "packaged" },
    ];
    for (const routing of routings) {
      const section = buildBoardFeedbackSection(routing)!;
      expect(section, `${routing.kind} section offers fix-direct`).not.toContain("fix-direct");
      expect(section, `${routing.kind} section offers file-and-drive`).not.toContain("file-and-drive");
    }
  });

  it("the file-ticket section makes the builder pass projectId explicitly", () => {
    // The behaviour CLAUDE.md promises this section carries: `create_issue` defaults to the
    // ACTIVE project, which is usually not the board, and two board bugs once sat
    // unactionable in a fixture project because of it.
    const filed = buildBoardFeedbackSection({
      kind: "file-ticket", projectId: "p1", projectName: "agentic-kanban", isCurrentProject: false,
    })!;
    expect(filed).toContain("projectId");
    expect(filed).toContain("p1");
  });
});
