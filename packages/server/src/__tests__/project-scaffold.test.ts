import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
  ensureAgentGitignore,
  ensureStarterClaudeMd,
  ensureVerifyGateRunner,
  GENERIC_AGENT_GITIGNORE,
  STARTER_CLAUDE_MD,
} from "../services/project-scaffold.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kanban-scaffold-"));
}

describe("project-scaffold", () => {
  it("creates a .gitignore with the language template + agent fragment when none exists", async () => {
    const dir = await tmp();
    try {
      ensureAgentGitignore(dir, "node_modules/\ndist/\n");
      const gi = await readFile(join(dir, ".gitignore"), "utf8");
      expect(gi).toContain("node_modules/");
      for (const line of GENERIC_AGENT_GITIGNORE) expect(gi).toContain(line);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("appends only missing agent lines to an existing .gitignore (idempotent, no clobber)", async () => {
    const dir = await tmp();
    try {
      await writeFile(join(dir, ".gitignore"), "node_modules/\nCLAUDE.local.md\n");
      ensureAgentGitignore(dir);
      let gi = await readFile(join(dir, ".gitignore"), "utf8");
      expect(gi).toContain("node_modules/"); // existing entry preserved
      expect(gi).toContain("verify-*.png"); // missing entry appended
      // CLAUDE.local.md already present -> not duplicated
      expect(gi.split(/\r?\n/).filter((l) => l.trim() === "CLAUDE.local.md").length).toBe(1);
      // Idempotent: a second run is a no-op
      const before = gi;
      ensureAgentGitignore(dir);
      gi = await readFile(join(dir, ".gitignore"), "utf8");
      expect(gi).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a starter CLAUDE.md only when absent (never clobbers an existing one)", async () => {
    const dir = await tmp();
    try {
      ensureStarterClaudeMd(dir);
      expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(STARTER_CLAUDE_MD);
      await writeFile(join(dir, "CLAUDE.md"), "custom project guidance");
      ensureStarterClaudeMd(dir);
      expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe("custom project guidance");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureVerifyGateRunner", () => {
  it("creates .claude/hooks/ dir with runner and config when absent", async () => {
    const dir = await tmp();
    try {
      ensureVerifyGateRunner(dir);
      const hooksDir = join(dir, ".claude", "hooks");
      expect(existsSync(hooksDir)).toBe(true);
      expect(existsSync(join(hooksDir, "verify-gate-runner.js"))).toBe(true);
      expect(existsSync(join(hooksDir, "verify-gate.config.json"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ships a valid JSON config stub with an empty command", async () => {
    const dir = await tmp();
    try {
      ensureVerifyGateRunner(dir);
      const cfg = JSON.parse(await readFile(join(dir, ".claude", "hooks", "verify-gate.config.json"), "utf8"));
      expect(typeof cfg.command).toBe("string");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing runner (idempotent, clobber-safe)", async () => {
    const dir = await tmp();
    try {
      const hooksDir = join(dir, ".claude", "hooks");
      await mkdir(hooksDir, { recursive: true });
      await writeFile(join(hooksDir, "verify-gate-runner.js"), "// custom runner");
      await writeFile(join(hooksDir, "verify-gate.config.json"), JSON.stringify({ command: "npm test" }));
      ensureVerifyGateRunner(dir);
      expect(await readFile(join(hooksDir, "verify-gate-runner.js"), "utf8")).toBe("// custom runner");
      expect(JSON.parse(await readFile(join(hooksDir, "verify-gate.config.json"), "utf8")).command).toBe("npm test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
