import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { BUILTIN_SKILLS } from "../builtin-skills.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Acceptance test for #90 — "kanban-workflow skill: commit-early nudge once
 * target tests pass".
 *
 * The skill teaches: the instant `tsc -b --noEmit` is clean for the touched
 * packages AND the directly-related tests pass, commit immediately, then push
 * any polish into a follow-up commit. This test stubs an agent that *follows*
 * that rule and asserts the branch ends up with >=2 commits doing meaningful
 * work — versus the old "batch everything into one final commit" pattern,
 * which we also reproduce here to show it yields a single commit.
 */

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) rej(new Error(stderr || err.message));
      else res(stdout.toString());
    });
  });
}

async function createTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kanban-checkpoint-test-"));
  await exec("git", ["init"], dir);
  await exec("git", ["config", "user.email", "test@test.com"], dir);
  await exec("git", ["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# Test\n");
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", "Initial commit"], dir);
  try {
    await exec("git", ["branch", "-M", "main"], dir);
  } catch {
    // already on main
  }
  return dir;
}

async function commitCount(dir: string, ref = "HEAD"): Promise<number> {
  const out = await exec("git", ["rev-list", "--count", ref], dir);
  return Number(out.trim());
}

/**
 * A stubbed agent that FOLLOWS the skill's commit-checkpoint rule:
 *   1. Write the core change, reach green (tsc clean + related tests pass).
 *   2. Commit immediately at the green checkpoint.
 *   3. Do queued polish in a separate, follow-up commit.
 */
async function runAgentFollowingCheckpoint(dir: string): Promise<void> {
  await exec("git", ["checkout", "-b", "feature/ak-stub-checkpoint", "main"], dir);

  // --- Phase 1: core implementation reaches green ---
  writeFileSync(join(dir, "feature.ts"), "export const feature = () => 42;\n");
  writeFileSync(join(dir, "feature.test.ts"), "// related test for feature.ts — passes\n");
  // tsc -b --noEmit clean AND related test green => COMMIT NOW.
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", "feat: core feature (green checkpoint)"], dir);

  // --- Phase 2: queued polish goes into a follow-up commit ---
  writeFileSync(join(dir, "feature.ts"), "export const feature = (): number => 42; // typed + doc\n");
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", "chore: polish feature typing/docs"], dir);
}

/**
 * The old pattern the skill is correcting: do all the work, then commit once
 * at the very end. A single interruption before this point loses everything.
 */
async function runAgentBatchingAtEnd(dir: string): Promise<void> {
  await exec("git", ["checkout", "-b", "feature/ak-stub-batch", "main"], dir);

  // Core reaches green here — but the agent keeps iterating without committing...
  writeFileSync(join(dir, "feature.ts"), "export const feature = () => 42;\n");
  writeFileSync(join(dir, "feature.test.ts"), "// related test — passes\n");
  // ...polish...
  writeFileSync(join(dir, "feature.ts"), "export const feature = (): number => 42; // typed + doc\n");
  // ...only now, at the very end, a single commit.
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", "feat: feature with polish (one final commit)"], dir);
}

describe("commit-checkpoint rule (#90)", () => {
  it("the skill text states a specific, actionable commit-checkpoint rule", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "kanban-workflow");
    expect(skill).toBeDefined();
    const prompt = skill!.prompt;
    // Not generic "commit early often" advice — it must name the concrete gates.
    expect(prompt).toMatch(/commit checkpoint/i);
    expect(prompt).toContain("tsc -b --noEmit");
    expect(prompt).toMatch(/--related/);
    expect(prompt).toMatch(/follow-up commit/i);
  });

  it("the monitor-nudge skill carries the commit-checkpoint hint", () => {
    const nudge = BUILTIN_SKILLS.find((s) => s.name === "monitor-nudge");
    expect(nudge).toBeDefined();
    expect(nudge!.prompt).toMatch(/commit checkpoint/i);
    expect(nudge!.prompt).toContain("tsc -b --noEmit");
  });

  it("the on-disk SKILL.md states the same rule", async () => {
    const skillPath = resolve(
      __dirname,
      "../../../../.claude/skills/kanban-workflow/SKILL.md",
    );
    const text = await readFile(skillPath, "utf-8");
    expect(text).toMatch(/commit checkpoint/i);
    expect(text).toContain("tsc -b --noEmit");
    expect(text).toMatch(/follow-up commit/i);
  });

  describe("a stubbed agent on a meaningful-work branch", () => {
    let repoPath: string;

    beforeAll(async () => {
      repoPath = await createTempRepo();
    });

    afterAll(async () => {
      try {
        await rm(repoPath, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });

    it("following the checkpoint rule produces >=2 commits", async () => {
      const base = await commitCount(repoPath, "main");
      await runAgentFollowingCheckpoint(repoPath);
      const branchCommits = await commitCount(repoPath, "feature/ak-stub-checkpoint");
      // commits added on the branch beyond the shared base
      expect(branchCommits - base).toBeGreaterThanOrEqual(2);
    });

    it("batching at the end produces only 1 commit (the pattern we're fixing)", async () => {
      const base = await commitCount(repoPath, "main");
      await runAgentBatchingAtEnd(repoPath);
      const branchCommits = await commitCount(repoPath, "feature/ak-stub-batch");
      expect(branchCommits - base).toBe(1);
    });
  });
});
