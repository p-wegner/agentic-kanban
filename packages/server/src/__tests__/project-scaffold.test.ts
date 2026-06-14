import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ensureAgentGitignore,
  ensureStarterClaudeMd,
  ensureStarterAgentsMd,
  ensureHookScaffold,
  ensureVerifyGateRunner,
  ensurePnpmBuildApproval,
  PNPM_BUILD_APPROVED_DEPS,
  GENERIC_AGENT_GITIGNORE,
  STARTER_CLAUDE_MD,
  STARTER_AGENTS_MD,
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

  it("writes a starter AGENTS.md only when absent (never clobbers an existing one)", async () => {
    const dir = await tmp();
    try {
      ensureStarterAgentsMd(dir);
      expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(STARTER_AGENTS_MD);
      await writeFile(join(dir, "AGENTS.md"), "custom agents guidance");
      ensureStarterAgentsMd(dir);
      expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("custom agents guidance");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the starter AGENTS.md carries the PowerShell + codex pitfalls block (the shell tax guardrail)", async () => {
    const dir = await tmp();
    try {
      ensureStarterAgentsMd(dir);
      const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
      // codex reads AGENTS.md, not CLAUDE.md — must say so
      expect(agents).toContain("codex reads THIS file");
      // The recurring PowerShell pitfalls the kanban CLAUDE.md already documents
      expect(agents).toContain("$pid"); // read-only automatic variables
      expect(agents).toContain("2>&1"); // native stderr redirect flips $?
      expect(agents).toContain("ParserError"); // unterminated-string failure
      expect(agents).toContain("PowerShell 5.1"); // no && / || / ternary
      // Prefer dedicated tools over the shell (Get-Content / git status / git diff spam)
      expect(agents).toContain("Get-Content");
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

    it("delivers smart-hooks-runner.js and wires PostToolUse + Stop with $CLAUDE_PROJECT_DIR paths (#787)", async () => {
      const dir = await tmp();
      try {
        await gitInit(dir);
        ensureHookScaffold(dir, { includeWorktreeGuard: false });

        const { existsSync } = await import("node:fs");
        expect(existsSync(join(dir, ".claude", "hooks", "smart-hooks-runner.js"))).toBe(true);

        const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
        const postCmds = (settings.hooks?.PostToolUse ?? []).flatMap(
          (e: { hooks?: { command: string }[] }) => (e.hooks ?? []).map((h: { command: string }) => h.command)
        );
        const stopCmds = (settings.hooks?.Stop ?? []).flatMap(
          (e: { hooks?: { command: string }[] }) => (e.hooks ?? []).map((h: { command: string }) => h.command)
        );
        const postRunner = postCmds.find((c: string) => c.includes("smart-hooks-runner.js PostToolUse"));
        const stopRunner = stopCmds.find((c: string) => c.includes("smart-hooks-runner.js Stop"));
        expect(postRunner).toBeTruthy();
        expect(stopRunner).toBeTruthy();
        expect(postRunner).toContain("$CLAUDE_PROJECT_DIR");
        expect(postRunner).not.toMatch(/^node [A-Z]:/i);
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

  describe("ensureVerifyGateRunner", () => {
    it("creates .claude/hooks/ dir with runner and config when absent", async () => {
      const dir = await tmp();
      try {
        ensureVerifyGateRunner(dir);
        const hooksDir = join(dir, ".claude", "hooks");
        const { existsSync } = await import("node:fs");
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

  describe("ensurePnpmBuildApproval (#777)", () => {
    it("adds esbuild to package.json pnpm.onlyBuiltDependencies so a Vite app builds clean", async () => {
      const dir = await tmp();
      try {
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({ name: "scaffolded-app", devDependencies: { vite: "^5", esbuild: "^0.21" } }, null, 2) + "\n"
        );
        ensurePnpmBuildApproval(dir);
        const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
        for (const dep of PNPM_BUILD_APPROVED_DEPS) {
          expect(pkg.pnpm.onlyBuiltDependencies).toContain(dep);
        }
        // esbuild specifically is approved (the #777 false-pass)
        expect(pkg.pnpm.onlyBuiltDependencies).toContain("esbuild");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("preserves deps the project already approved and is idempotent", async () => {
      const dir = await tmp();
      try {
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({ name: "app", pnpm: { onlyBuiltDependencies: ["sharp"] } }, null, 2) + "\n"
        );
        ensurePnpmBuildApproval(dir);
        let pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
        expect(pkg.pnpm.onlyBuiltDependencies).toContain("sharp");
        expect(pkg.pnpm.onlyBuiltDependencies).toContain("esbuild");
        const afterFirst = await readFile(join(dir, "package.json"), "utf8");
        ensurePnpmBuildApproval(dir);
        const afterSecond = await readFile(join(dir, "package.json"), "utf8");
        expect(afterSecond).toBe(afterFirst); // idempotent — no churn
        pkg = JSON.parse(afterSecond);
        expect(pkg.pnpm.onlyBuiltDependencies.filter((d: string) => d === "esbuild").length).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("repairs a broken pnpm-workspace.yaml (bogus allowBuilds placeholder) to a VALID onlyBuiltDependencies list", async () => {
      const dir = await tmp();
      try {
        const broken =
          'packages:\n  - "packages/*"\nallowBuilds:\n  esbuild: "set this to true or false"\n';
        await writeFile(join(dir, "pnpm-workspace.yaml"), broken);
        const changed = ensurePnpmBuildApproval(dir);
        expect(changed).toBe(true);
        const ws = await readFile(join(dir, "pnpm-workspace.yaml"), "utf8");
        // never the placeholder, never the bogus (non-pnpm) allowBuilds key
        expect(ws).not.toContain("set this to true or false");
        expect(ws).not.toContain("allowBuilds");
        // a real pnpm key with esbuild approved
        expect(ws).toMatch(/onlyBuiltDependencies:/);
        expect(ws).toMatch(/-\s*esbuild/);
        // the unrelated packages block is preserved
        expect(ws).toContain('packages:');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("pins packageManager to a pnpm version that honors the approval, for a pnpm project (#783)", async () => {
      const dir = await tmp();
      try {
        await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }, null, 2) + "\n");
        await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        const changed = ensurePnpmBuildApproval(dir);
        expect(changed).toBe(true);
        const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
        expect(typeof pkg.packageManager).toBe("string");
        expect(pkg.packageManager).toMatch(/^pnpm@/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("does NOT pin pnpm onto a non-pnpm project (no lockfile / pnpm config)", async () => {
      const dir = await tmp();
      try {
        // npm-style project: has a package.json but no pnpm signal
        await writeFile(join(dir, "package.json"), JSON.stringify({ name: "npm-app" }, null, 2) + "\n");
        ensurePnpmBuildApproval(dir);
        const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
        expect(pkg.packageManager).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("no-ops when there is no package.json or pnpm-workspace.yaml", async () => {
      const dir = await tmp();
      try {
        ensurePnpmBuildApproval(dir); // must not throw
        const { existsSync } = await import("node:fs");
        expect(existsSync(join(dir, "package.json"))).toBe(false);
        expect(existsSync(join(dir, "pnpm-workspace.yaml"))).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("is invoked by ensureVerifyGateRunner so the scaffold flow approves esbuild", async () => {
      const dir = await tmp();
      try {
        await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }, null, 2) + "\n");
        ensureVerifyGateRunner(dir);
        const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
        expect(pkg.pnpm.onlyBuiltDependencies).toContain("esbuild");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

