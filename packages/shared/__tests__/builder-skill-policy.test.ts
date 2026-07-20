import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BUILDER_SKILL_ALLOWLIST,
  isBuilderRelevantSkill,
  selectBuilderSkills,
  buildSkillInvocationBlock,
} from "../src/lib/builder-skill-policy.js";
import { listLocalSkillNames, writeAgentSkillFile } from "../src/lib/agent-skill-files.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kanban-builder-skill-"));
}

describe("BUILDER_SKILL_ALLOWLIST", () => {
  it("keeps the skills a worktree agent fires", () => {
    for (const name of ["board-navigator", "kanban-workflow", "scope-guard", "code-review"]) {
      expect(isBuilderRelevantSkill(name)).toBe(true);
    }
  });

  it("excludes board-side skills that never run in a worktree (#129 context tax)", () => {
    for (const name of ["dependency-analyzer", "ticket-enhancer", "orchestrator", "monitor-nudge", "code-review-thorough"]) {
      expect(isBuilderRelevantSkill(name)).toBe(false);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(BUILDER_SKILL_ALLOWLIST).size).toBe(BUILDER_SKILL_ALLOWLIST.length);
  });
});

describe("selectBuilderSkills", () => {
  it("filters to the allowlist, preserving caller order", () => {
    expect(selectBuilderSkills(["ticket-enhancer", "scope-guard", "orchestrator", "board-navigator"]))
      .toEqual(["scope-guard", "board-navigator"]);
  });

  it("drops duplicates", () => {
    expect(selectBuilderSkills(["code-review", "code-review"])).toEqual(["code-review"]);
  });

  it("returns empty for a worktree with only irrelevant skills", () => {
    expect(selectBuilderSkills(["monitor-nudge", "publish"])).toEqual([]);
  });
});

describe("buildSkillInvocationBlock", () => {
  it("returns empty string when there is nothing to announce", () => {
    // An empty "Available Skills" heading would itself be per-turn tax.
    expect(buildSkillInvocationBlock([])).toBe("");
    expect(buildSkillInvocationBlock(["", "   "])).toBe("");
  });

  it("names each skill so the agent knows to invoke it", () => {
    const block = buildSkillInvocationBlock(["scope-guard", "code-review"]);
    expect(block).toContain("scope-guard");
    expect(block).toContain("code-review");
    expect(block.toLowerCase()).toContain("invoke");
  });

  it("dedupes and trims", () => {
    const block = buildSkillInvocationBlock([" code-review ", "code-review"]);
    // Once in the list; the invocation example reuses the first entry as `/name`.
    expect(block.match(/`code-review`/g)?.length).toBe(1);
    expect(block).toContain("`/code-review`");
  });

  it("stays short — it is re-billed on every turn", () => {
    const block = buildSkillInvocationBlock([...BUILDER_SKILL_ALLOWLIST]);
    expect(block.length).toBeLessThan(700);
  });
});

describe("listLocalSkillNames", () => {
  it("returns [] when .claude/skills is absent", async () => {
    const dir = await tmp();
    try {
      expect(await listLocalSkillNames(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists skill directory names without reading SKILL.md bodies", async () => {
    const dir = await tmp();
    try {
      await writeAgentSkillFile(dir, { name: "scope-guard", description: "d", prompt: "p" });
      // A directory with no SKILL.md still counts as present — we only need names.
      await mkdir(join(dir, ".claude", "skills", "board-navigator"), { recursive: true });
      const names = await listLocalSkillNames(dir);
      expect(names.sort()).toEqual(["board-navigator", "scope-guard"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores loose files inside .claude/skills", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, ".claude", "skills"), { recursive: true });
      await writeFile(join(dir, ".claude", "skills", "README.md"), "# skills\n");
      expect(await listLocalSkillNames(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
