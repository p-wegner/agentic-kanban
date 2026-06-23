import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture gate: no source file may exceed {@link MAX_LINES} lines.
 *
 * God-files (one module accreting many concerns) are the recurring code-quality
 * regression in this repo — repeatedly driven back under 1000 lines by hand
 * (the client/server/shared decomposition campaigns). This test makes that
 * convention machine-checked so a file can never silently grow back into a
 * god-module: the moment one crosses the line, CI fails and the author
 * decomposes it (extract a cohesive sub-module, or split a god-file behind a
 * facade barrel — see packages/shared/src/lib/git-service.ts /
 * workflow-engine.ts for the pattern).
 *
 * The bar is 1000 lines, the established team threshold the whole codebase
 * already sits under. The ALLOWLIST is intentionally EMPTY and must only ever
 * SHRINK: prefer decomposing the file over adding an exception. Tests, generated
 * code, dist and vendored code are excluded (they are not hand-maintained
 * modules subject to the same readability budget).
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const MAX_LINES = 1000;

/**
 * Files permitted to exceed MAX_LINES, with a reason. Keep this EMPTY if you can;
 * a non-empty entry is a debt marker, not a license to grow. Paths are relative
 * to the repo root and use forward slashes.
 */
const ALLOWLIST = new Map<string, string>([
  // e.g. ["packages/shared/src/types/api.ts", "hand-authored wire DTOs; cohesive"],
]);

function isExcluded(absPath: string): boolean {
  const parts = absPath.split(sep);
  return (
    parts.includes("node_modules") ||
    parts.includes("dist") ||
    parts.includes(".worktrees") ||
    parts.includes("__tests__") ||
    absPath.endsWith(".test.ts") ||
    absPath.endsWith(".test.tsx") ||
    absPath.endsWith(".spec.ts") ||
    absPath.endsWith(".d.ts")
  );
}

function collectSourceFiles(dir: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (isExcluded(full)) continue;
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
}

describe("max-file-size gate", () => {
  it(`no package source file exceeds ${MAX_LINES} lines`, () => {
    const packagesDir = join(REPO_ROOT, "packages");
    const files: string[] = [];
    for (const pkg of readdirSync(packagesDir)) {
      if (pkg === ".worktrees") continue;
      collectSourceFiles(join(packagesDir, pkg, "src"), files);
    }

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      if (ALLOWLIST.has(rel)) continue;
      // Count newline-terminated lines; a trailing newline does not add a line.
      const text = readFileSync(file, "utf8");
      const lineCount = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      if (lineCount > MAX_LINES) offenders.push(`${rel}  (${lineCount} lines)`);
    }

    expect(
      offenders,
      `These source files exceed the ${MAX_LINES}-line god-file limit. Decompose them ` +
        `(extract a cohesive sub-module, or split behind a facade barrel — see ` +
        `git-service.ts / workflow-engine.ts) rather than adding them to the allowlist:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("the allowlist is live, not stale (every entry still exists and still exceeds the limit)", () => {
    const stale: string[] = [];
    for (const rel of ALLOWLIST.keys()) {
      const abs = join(REPO_ROOT, rel);
      let lineCount = 0;
      try {
        const text = readFileSync(abs, "utf8");
        lineCount = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      } catch {
        stale.push(`${rel} (missing)`);
        continue;
      }
      if (lineCount <= MAX_LINES) stale.push(`${rel} (now ${lineCount} lines — remove from allowlist)`);
    }
    expect(stale, `Stale allowlist entries:\n${stale.join("\n")}`).toEqual([]);
  });
});
