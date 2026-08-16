// @gate:always-run — walks every package's src tree, so its subject is not in this
// file's import graph and scoped test selection must not skip it.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Every child_process spawn passes `windowsHide: true` (#597).
 *
 * This is a CLAUDE.md HARD CONSTRAINT, not a style rule: a spawn without it flashes a
 * console window on Windows, which steals focus and — the reason it is a hard constraint —
 * can disrupt other agents' worktree servers running on the same machine. It is invisible
 * on CI and on the maintainer's non-Windows runs, so nothing but a scanner catches it.
 *
 * Matching is deliberately narrow, because the obvious regex is badly wrong here:
 *   - `/re/.exec(text)` is a RegExp method, not a spawn. A naive `exec\(` pattern reports
 *     ~67 offenders, almost all regex calls. This resolves the child_process import first
 *     and only matches the identifiers actually bound from it (honouring `as` aliases),
 *     which brings the real count to 35 call sites.
 *   - options are usually on a LATER line than the callee, so a same-line check
 *     mis-reports correct multi-line calls. This reads the whole call expression by
 *     tracking paren depth.
 */
const PACKAGES = path.resolve(import.meta.dirname, "../../../..", "packages");

const SPAWN_FNS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);

/**
 * Calls that must NOT hide their window, each with the reason. Every entry here opens a
 * window FOR THE USER on purpose — hiding it would defeat the feature outright.
 */
const ALLOWED: Record<string, string> = {
  "server/src/services/claude-login.service.ts": "opens a terminal for interactive login — the window IS the feature",
  "server/src/services/codex-login.service.ts": "opens a terminal for interactive login — the window IS the feature",
  "server/src/services/project.service.ts": "explorer/open — shows the user a folder; hiding it does nothing useful",
  "server/src/services/workspace-session.service.ts": "opens a visible terminal attached to a workspace, on user request",
};

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "__tests__") return [];
      return tsFiles(full);
    }
    return e.name.endsWith(".ts") && !e.name.includes(".test.") ? [full] : [];
  });
}

/** Local names bound from child_process in this file (handles `execFile as ef`). */
function spawnBindings(text: string): string[] {
  const names: string[] = [];
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(?:node:)?child_process"/g;
  for (const m of text.matchAll(importRe)) {
    for (const raw of m[1].split(",")) {
      const spec = raw.trim();
      if (!spec) continue;
      const [orig, alias] = spec.split(" as ").map((x) => x.trim());
      if (SPAWN_FNS.has(orig)) names.push(alias ?? orig);
    }
  }
  return names;
}

function callSitesMissingHide(file: string): number[] {
  const text = readFileSync(file, "utf8");
  const names = spawnBindings(text);
  if (names.length === 0) return [];
  const lines = text.split("\n");
  // (?<![.\w]) so `foo.exec(` and `myExec(` never match a bare `exec` binding.
  const callRe = new RegExp(`(?<![.\\w])(${names.join("|")})\\s*\\(`);
  const missing: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) continue;
    if (stripped.startsWith("import")) continue;
    if (!callRe.test(lines[i])) continue;

    let depth = 0;
    const window: string[] = [];
    for (let j = i; j < Math.min(i + 16, lines.length); j++) {
      window.push(lines[j]);
      depth += (lines[j].match(/\(/g)?.length ?? 0) - (lines[j].match(/\)/g)?.length ?? 0);
      if (j > i && depth <= 0) break;
    }
    if (!window.join("\n").includes("windowsHide")) missing.push(i + 1);
  }
  return missing;
}

describe("windowsHide on every child_process spawn (#597)", () => {
  const files = tsFiles(PACKAGES).filter((f) => /[\\/]src[\\/]/.test(f));

  it("finds spawn call sites, so the scan cannot pass vacuously", () => {
    const withSpawns = files.filter((f) => spawnBindings(readFileSync(f, "utf8")).length > 0);
    expect(withSpawns.length).toBeGreaterThanOrEqual(10);
  });

  it("no spawn omits windowsHide outside the allowlist", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(PACKAGES, file).replaceAll("\\", "/");
      if (rel in ALLOWED) continue;
      for (const line of callSitesMissingHide(file)) offenders.push(`${rel}:${line}`);
    }
    expect(
      offenders,
      `these spawn without windowsHide (CLAUDE.md hard constraint):\n${offenders.join("\n")}\n` +
        "Add `windowsHide: true` to the options, or add the file to ALLOWED with the reason its window must be visible.",
    ).toEqual([]);
  });

  it("every allowlist entry still names a file that spawns", () => {
    const stale = Object.keys(ALLOWED).filter((rel) => {
      const abs = path.join(PACKAGES, rel);
      try {
        return spawnBindings(readFileSync(abs, "utf8")).length === 0;
      } catch {
        return true; // file gone
      }
    });
    expect(stale, `allowlist entries no longer spawning: ${stale.join(", ")}`).toEqual([]);
  });
});
