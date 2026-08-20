/**
 * #583 — the gate's guard-suite count must mean what it says.
 *
 * `countAlwaysRunGuardSuites` feeds the "+N guard suites" figure in a passing gate's message,
 * which is the one place an operator can see WHICH verification a weakened tier still carries.
 * Its private scan was FLAT and `.test.ts`-only, so `mcp-server/src/__tests__/tools/` (33
 * suites) and every `.test.tsx`/`.test.mjs` were invisible: the number was silently narrower
 * than the set `scripts/test-mine.mjs` actually forces to run. A number that quietly means
 * something else is worse than no number, because it is what gets checked instead of the list.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countAlwaysRunGuardSuites, ALWAYS_RUN_TESTS_DIRS } from "../services/pre-merge-gate-tier.js";

const MARKER = "// @gate:always-run\n";

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "guard-count-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe("countAlwaysRunGuardSuites (#583)", () => {
  it("counts a marked suite in a NESTED dir — the flat scan missed 33 of them", () => {
    const serverTests = ALWAYS_RUN_TESTS_DIRS[1];
    const root = repoWith({
      [join(serverTests, "top.test.ts")]: MARKER,
      [join(serverTests, "tools", "nested.test.ts")]: MARKER,
      [join(serverTests, "tools", "deep", "deeper.test.ts")]: MARKER,
    });
    try {
      expect(countAlwaysRunGuardSuites(root)).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts every test extension test-mine recognises, not just `.test.ts`", () => {
    const serverTests = ALWAYS_RUN_TESTS_DIRS[1];
    const root = repoWith({
      [join(serverTests, "a.test.ts")]: MARKER,
      [join(serverTests, "b.test.tsx")]: MARKER,
      [join(serverTests, "c.test.mjs")]: MARKER,
      [join(serverTests, "d.test.js")]: MARKER,
    });
    try {
      expect(countAlwaysRunGuardSuites(root)).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores unmarked suites, non-test files, and node_modules", () => {
    const serverTests = ALWAYS_RUN_TESTS_DIRS[1];
    const root = repoWith({
      [join(serverTests, "marked.test.ts")]: MARKER,
      [join(serverTests, "plain.test.ts")]: "// nothing\n",
      [join(serverTests, "helper.ts")]: MARKER,
      [join(serverTests, "node_modules", "vendor.test.ts")]: MARKER,
    });
    try {
      expect(countAlwaysRunGuardSuites(root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stays a decoration — an absent tree yields 0 rather than throwing", () => {
    expect(countAlwaysRunGuardSuites(join(tmpdir(), "no-such-repo-root-583"))).toBe(0);
  });
});
