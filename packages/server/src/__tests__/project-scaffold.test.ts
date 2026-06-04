import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ensureAgentGitignore,
  ensureStarterClaudeMd,
  ensureHookScaffold,
  GENERIC_AGENT_GITIGNORE,
  STARTER_CLAUDE_MD,
} from "../services/project-scaffold.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kanban-scaffold-"));
}

/** Initialise a bare git repo so git-dependent code (worktree detection) works. */
async function gitInit(dir: string): Promise<void> {
  execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: dir, windowsHide: true });
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

  describe("ensureHookScaffold", () => {
    it("creates .claude/hooks directory and writes vital-files.json + smart-hooks-config.json + README", async () => {
      const dir = await tmp();
      try {
        await gitInit(dir);
        ensureHookScaffold(dir, { vitalFiles: ["data/app.db"], includeWorktreeGuard: false });

        const hooksDir = join(dir, ".claude", "hooks");
        const vitalFiles = JSON.parse(await readFile(join(hooksDir, "vital-files.json"), "utf8"));
        expect(vitalFiles).toContain("data/app.db");

        const smartConfig = JSON.parse(await readFile(join(hooksDir, "smart-hooks-config.json"), "utf8"));
        expect(smartConfig).toHaveProperty("version");
        expect(Array.isArray(smartConfig.hooks.PreToolUse)).toBe(true);

        const readme = await readFile(join(hooksDir, "README.md"), "utf8");
        expect(readme).toContain("vital-file-guard");
        expect(readme).toContain("ALLOW_VITAL_DESTROY");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("writes settings.json with hook entries using $CLAUDE_PROJECT_DIR paths (no absolute paths)", async () => {
      const dir = await tmp();
      try {
        await gitInit(dir);
        ensureHookScaffold(dir, { includeWorktreeGuard: false });

        const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
        const preToolHooks = settings.hooks?.PreToolUse ?? [];
        const commands: string[] = preToolHooks.flatMap((e: { hooks?: { command: string }[] }) =>
          (e.hooks ?? []).map((h: { command: string }) => h.command)
        );
        const vitalCmd = commands.find((c) => c.includes("vital-file-guard.js"));
        expect(vitalCmd).toBeTruthy();
        // Must use $CLAUDE_PROJECT_DIR, not an absolute platform path
        expect(vitalCmd).toContain("$CLAUDE_PROJECT_DIR");
        expect(vitalCmd).not.toMatch(/^node [A-Z]:/i);
        expect(vitalCmd).not.toMatch(/^node \/(?!.*\$CLAUDE_PROJECT_DIR)/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("appends to an existing settings.json without overwriting existing entries", async () => {
      const dir = await tmp();
      try {
        await gitInit(dir);
        await mkdir(join(dir, ".claude"), { recursive: true });
        const existingSettings = {
          mcpServers: { myServer: { command: "npx", args: ["my-mcp"] } },
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node my-existing-hook.js" }] }],
          },
        };
        await writeFile(join(dir, ".claude", "settings.json"), JSON.stringify(existingSettings, null, 2), "utf8");

        ensureHookScaffold(dir, { includeWorktreeGuard: false });

        const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
        // Existing mcpServers preserved
        expect(settings.mcpServers?.myServer).toBeDefined();
        // Existing hook preserved
        const existingCmd = settings.hooks.PreToolUse.find(
          (e: { hooks?: { command: string }[] }) => e.hooks?.some((h: { command: string }) => h.command === "node my-existing-hook.js")
        );
        expect(existingCmd).toBeDefined();
        // New vital-file-guard hook added
        const newCmd = settings.hooks.PreToolUse.find(
          (e: { hooks?: { command: string }[] }) => e.hooks?.some((h: { command: string }) => h.command.includes("vital-file-guard.js"))
        );
        expect(newCmd).toBeDefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("is idempotent: a second run does not duplicate settings.json entries or overwrite vital-files.json", async () => {
      const dir = await tmp();
      try {
        await gitInit(dir);
        ensureHookScaffold(dir, { vitalFiles: ["app.db"], includeWorktreeGuard: false });
        const settingsAfterFirst = await readFile(join(dir, ".claude", "settings.json"), "utf8");

        ensureHookScaffold(dir, { vitalFiles: ["app.db"], includeWorktreeGuard: false });
        const settingsAfterSecond = await readFile(join(dir, ".claude", "settings.json"), "utf8");

        // Settings must not grow (no duplicate entries)
        const s1 = JSON.parse(settingsAfterFirst);
        const s2 = JSON.parse(settingsAfterSecond);
        expect(s2.hooks.PreToolUse.length).toBe(s1.hooks.PreToolUse.length);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("skips the worktree guard when repo has no worktrees", async () => {
      const dir = await tmp();
      try {
        await gitInit(dir);
        // Single-worktree repo — guard must not be installed automatically
        ensureHookScaffold(dir); // no includeWorktreeGuard override

        const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
        const allCmds = (settings.hooks?.PreToolUse ?? []).flatMap(
          (e: { hooks?: { command: string }[] }) => (e.hooks ?? []).map((h: { command: string }) => h.command)
        );
        expect(allCmds.some((c: string) => c.includes("prevent-cross-worktree-writes.js"))).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("includes the worktree guard when includeWorktreeGuard is forced to true", async () => {
      const dir = await tmp();
      try {
        await gitInit(dir);
        ensureHookScaffold(dir, { includeWorktreeGuard: true });

        const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
        const allCmds = (settings.hooks?.PreToolUse ?? []).flatMap(
          (e: { hooks?: { command: string }[] }) => (e.hooks ?? []).map((h: { command: string }) => h.command)
        );
        expect(allCmds.some((c: string) => c.includes("prevent-cross-worktree-writes.js"))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("does not clobber an existing vital-files.json", async () => {
      const dir = await tmp();
      try {
        await gitInit(dir);
        await mkdir(join(dir, ".claude", "hooks"), { recursive: true });
        await writeFile(join(dir, ".claude", "hooks", "vital-files.json"), JSON.stringify(["custom.db"]), "utf8");

        ensureHookScaffold(dir, { vitalFiles: ["should-not-appear.db"], includeWorktreeGuard: false });

        const vitalFiles = JSON.parse(await readFile(join(dir, ".claude", "hooks", "vital-files.json"), "utf8"));
        expect(vitalFiles).toContain("custom.db");
        expect(vitalFiles).not.toContain("should-not-appear.db");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

