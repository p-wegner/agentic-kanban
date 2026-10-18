// @gate:always-run always — scans every tracked file; imports nothing it checks (#1599).
// @gate:static — source-scanning ratchet: runs in the static tier (`pnpm check:static`), never held.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * #1599 — machine-local paths (a drive-letter project/temp root, the OS user's home) were
 * committed in docs, skills and test fixtures. The organisation name is fine; local paths are
 * not. Docs say `<repo>` / `~` / `%TEMP%`; fixtures use a neutral `C:\Users\dev\...`.
 *
 * The patterns are assembled from parts so this file does not trip itself.
 */
const USER = ["pw", "egner"].join("");
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // The Docker Hub namespace (`<user>3141`) is a public identity, not a local path.
  { name: "OS user name", re: new RegExp(`${USER}(?!\\d)`, "i") },
  { name: "home dir of the operator", re: /Users[\\/]+Peter\b/ },
  { name: "D: drive projects/tmp root", re: /\bD:[\\/]+(?:projects|tmp)\b/i },
  { name: "git-bash D: projects root", re: /\/d\/projects\//i },
];

const ROOT = path.resolve(__dirname, "../../../..");
const SELF = path.relative(ROOT, __filename).split(path.sep).join("/");
const SKIP = new Set(["pnpm-lock.yaml", SELF]);

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter((f) => f && !SKIP.has(f));
}

describe("no machine-local paths in tracked files (#1599)", () => {
  it("contains no operator user name or D:\\projects-style path", () => {
    const hits: string[] = [];
    for (const rel of trackedFiles()) {
      const abs = path.join(ROOT, rel);
      let text: string;
      try {
        if (fs.statSync(abs).size > 5 * 1024 * 1024) continue;
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const { name, re } of PATTERNS) {
          if (re.test(lines[i])) hits.push(`${rel}:${i + 1} (${name})`);
        }
      }
    }
    expect(hits, "use <repo>, ~, %TEMP% or C:\\Users\\dev in place of a real local path").toEqual([]);
  });
});
