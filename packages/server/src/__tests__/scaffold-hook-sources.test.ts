// @gate:always-run — byte-compares scaffold hooks against .claude/hooks/ outside src/; imports nothing it checks (#538).
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The scaffold hooks shipped to published installs (dist/scaffold/hooks/ via
// scripts/copy-assets.mjs) and written into new projects by project-scaffold.ts.
// verify-gate-runner.js has its own identity test in verify-gate-runner.test.ts (#952).
const HOOKS = [
  "vital-file-guard.js",
  "prevent-cross-worktree-writes.js",
  "smart-hooks-runner.js",
  // #392: the runner requires this at load time to memoize the git topology lookups (#279).
  // It drifted in the other direction — the live copy had the speedups and the scaffold source
  // did not — so scaffolded projects were getting the SLOW runner. Pinned here so the pair
  // cannot separate again.
  "git-topology-cache.js",
  // #913: the runner's posture/capacity policy. Loaded defensively (a pre-#913 project
  // survives without them), but shipped — so the same drift rule applies.
  "hook-posture.js",
  "machine-capacity.js",
  // #922: same dual-copy shape as the others above.
  "disclose-context.mjs",
];

const SCAFFOLD_DIR = join(__dirname, "../scaffold");
const LIVE_HOOKS_DIR = join(__dirname, "../../../../.claude/hooks");

describe("scaffold hook sources — source identity (#990, mirrors #952)", () => {
  // Two copies of each hook exist on purpose: packages/server/src/scaffold/<name>.js is the
  // canonical source (shipped to dist/scaffold/hooks/ by copy-assets.mjs and resolved by
  // resolveHookSource), and .claude/hooks/<name>.js is this checkout's live hook. If they
  // drift, the tested/shipped artifact no longer matches the deployed one — keep them in
  // sync manually (edit the scaffold source, copy to .claude/hooks/, or vice versa).
  for (const hook of HOOKS) {
    it(`${hook}: the deployed .claude/hooks copy is byte-identical to the canonical scaffold source`, async () => {
      const canonical = await readFile(join(SCAFFOLD_DIR, hook), "utf8");
      const deployed = await readFile(join(LIVE_HOOKS_DIR, hook), "utf8");
      expect(deployed).toBe(canonical);
    });
  }
});

/**
 * #472 part 2 — a fix to a board-owned hook must actually REACH existing projects.
 *
 * `ensureHookScaffold` wrote each hook once (`if (!existsSync(...))`) and never again, so every
 * guard fix reached only NEWLY registered projects. That is how the #472 cross-worktree hole
 * would have survived in `eventhub-backend` indefinitely: the guard was present there and
 * correctly wired on both matchers — it was simply built before the fix existed. Same
 * distribution defect as #392, one level up: there the scaffold source had drifted from the
 * deployed copy, here the deployed copy could never catch up.
 */
describe("board-owned hooks refresh when the shipped version is newer (#472)", () => {
  const HOOKS = [
    "vital-file-guard.js",
    "prevent-cross-worktree-writes.js",
    "smart-hooks-runner.js",
    "git-topology-cache.js",
    "hook-posture.js",
    "machine-capacity.js",
    "disclose-context.mjs",
  ];

  it("every shipped hook source carries a version banner", () => {
    // Without it the refresh cannot tell old from new and would either never fire or fire always.
    for (const name of HOOKS) {
      const src = readFileSync(join(SCAFFOLD_DIR, name), "utf8");
      expect(src, name).toMatch(/^\/\/ @board-hook-version: \d+$/m);
    }
  });

  it("puts the banner AFTER the shebang, never before it", () => {
    // Prepending it above `#!/usr/bin/env node` made every hook a syntax error — and because a
    // crashing hook exits non-zero, the guards then fail CLOSED and block every command. Caught
    // live while building this; the ordering is the assertion.
    for (const name of HOOKS) {
      const lines = readFileSync(join(SCAFFOLD_DIR, name), "utf8").split(/\r?\n/);
      const bannerAt = lines.findIndex((l) => l.startsWith("// @board-hook-version:"));
      const shebangAt = lines.findIndex((l) => l.startsWith("#!"));
      if (shebangAt !== -1) expect(shebangAt, name).toBeLessThan(bannerAt);
      else expect(bannerAt, name).toBe(0);
    }
  });

  it("refreshes an out-of-date copy and leaves a current one alone", async () => {
    const { ensureHookScaffold } = await import("../services/project-scaffold.js");
    const repo = mkdtempSync(join(tmpdir(), "ak-hook-refresh-"));
    try {
      const guardPath = join(repo, ".claude", "hooks", "prevent-cross-worktree-writes.js");
      mkdirSync(join(repo, ".claude", "hooks"), { recursive: true });
      // A copy predating the mechanism: no banner at all, i.e. version 0.
      writeFileSync(guardPath, "#!/usr/bin/env node\n// an old guard\n", "utf8");

      ensureHookScaffold(repo);
      const refreshed = readFileSync(guardPath, "utf8");
      expect(refreshed).toMatch(/@board-hook-version: \d+/);
      expect(refreshed).not.toContain("an old guard");

      // Second pass is a no-op — idempotent, and it must not rewrite on every registration.
      const mtimeBefore = statSync(guardPath).mtimeMs;
      ensureHookScaffold(repo);
      expect(statSync(guardPath).mtimeMs).toBe(mtimeBefore);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
    // #922 added a 6th hook write (disclose-context.mjs) to ensureHookScaffold; the extra
    // resolveHookSource/fs + settings-merge work pushed this past vitest's 5000ms default
    // under load (mirrors the mock-agent timeout bumps elsewhere in this repo).
  }, 20000);

  it("does not downgrade a copy that is somehow AHEAD of the shipped source", async () => {
    const { ensureHookScaffold } = await import("../services/project-scaffold.js");
    const repo = mkdtempSync(join(tmpdir(), "ak-hook-ahead-"));
    try {
      const guardPath = join(repo, ".claude", "hooks", "prevent-cross-worktree-writes.js");
      mkdirSync(join(repo, ".claude", "hooks"), { recursive: true });
      const ahead = "#!/usr/bin/env node\n// @board-hook-version: 9999\n// from the future\n";
      writeFileSync(guardPath, ahead, "utf8");
      ensureHookScaffold(repo);
      expect(readFileSync(guardPath, "utf8")).toBe(ahead);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);
});
