// @gate:always-run
//
// The bundled `agentic-kanban` skill is generated FROM source (MCP tool table, CLI command
// files, view/shortcut registries) — so adding an MCP tool or a CLI command silently makes
// what every agent reads wrong, and nothing in that tool's own import graph would notice.
// This suite spawns the generator's --check mode, which reaches the whole repo tree; hence
// the marker, without which `vitest related` scoping would drop it exactly when it matters.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const GENERATOR = join(REPO_ROOT, "packages/server/scripts/generate-bundled-skill.mjs");
const SKILL_DIR = join(REPO_ROOT, "packages/server/skills/agentic-kanban");

describe("bundled agent skill", () => {
  it("is regenerated from source — run `pnpm skill:generate` if this fails", () => {
    let output = "";
    let failed = false;
    try {
      output = execFileSync(process.execPath, [GENERATOR, "--check"], {
        cwd: REPO_ROOT, encoding: "utf-8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    expect(failed ? output : "").toBe("");
  });

  it("ships the SKILL.md and every reference it points at", () => {
    const skillMd = join(SKILL_DIR, "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
    const content = readFileSync(skillMd, "utf-8");

    // A reference the skill names but does not ship is a dead end an agent cannot recover from.
    const referenced = [...content.matchAll(/`references\/([\w-]+\.md)`/g)].map(m => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const file of new Set(referenced)) {
      expect(existsSync(join(SKILL_DIR, "references", file)), `missing references/${file}`).toBe(true);
    }
  });

  it("carries the frontmatter an agent host needs to load it", () => {
    const content = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf-8");
    const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/.exec(content);
    expect(block, "SKILL.md has no frontmatter block").toBeTruthy();
    const fields = block![1];
    expect(fields).toMatch(/^name: agentic-kanban$/m);
    expect(fields).toMatch(/^description: .{40,}$/m);
    expect(fields).toMatch(/^commit: \w+$/m);
  });
});
