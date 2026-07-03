import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The scaffold hooks shipped to published installs (dist/scaffold/hooks/ via
// scripts/copy-assets.mjs) and written into new projects by project-scaffold.ts.
// verify-gate-runner.js has its own identity test in verify-gate-runner.test.ts (#952).
const HOOKS = [
  "vital-file-guard.js",
  "prevent-cross-worktree-writes.js",
  "smart-hooks-runner.js",
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
