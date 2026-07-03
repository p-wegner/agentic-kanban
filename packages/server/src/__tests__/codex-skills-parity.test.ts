import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";

/**
 * .codex/skills parity gate (#965).
 *
 * The committed `.codex/skills/*` tree is a mirror of `.claude/skills/*` (on dev
 * machines `.codex/skills` is often a local junction onto `.claude/skills`, which
 * git does NOT track — both trees are committed as independent file sets). That
 * makes silent drift possible: a skill edited under `.claude/skills` whose
 * committed `.codex` copy is never refreshed (this happened to `publish` and
 * `dev-server`).
 *
 * This test compares the GIT INDEX content (`git show :<path>`) — not the working
 * tree — because on junctioned dev machines the two on-disk paths are literally
 * the same file and a disk comparison would trivially pass even while the
 * committed copies drift. Comparing the index catches committed/staged drift on
 * every machine, including fresh clones.
 *
 * Only pairs tracked on BOTH sides are compared; a skill that legitimately exists
 * on one side only is not an error here (but as of #965 the two trees are fully
 * symmetric — see the symmetry expectations' messages if that changes).
 */

const REPO_ROOT = join(__dirname, "../../../..");

/** Normalize line endings so CRLF-vs-LF checkouts never produce a false drift. */
function normalizeEol(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/** Tracked path -> index blob hash, in one git spawn (fast on Windows). */
function lsFilesWithBlobs(prefix: string): Map<string, string> {
  // `-s` format: "<mode> <blob> <stage>\t<path>", NUL-terminated with -z.
  const out = gitExecSync(["ls-files", "-s", "-z", "--", prefix], { cwd: REPO_ROOT });
  const map = new Map<string, string>();
  for (const entry of out.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const [, blob] = entry.slice(0, tab).split(/\s+/);
    map.set(entry.slice(tab + 1), blob);
  }
  return map;
}

function indexContent(trackedPath: string): string {
  // `:<path>` = the file's content in the index (== HEAD unless staged changes).
  return gitExecSync(["show", `:${trackedPath}`], { cwd: REPO_ROOT });
}

describe("codex skills parity (#965)", () => {
  const claudeBlobs = lsFilesWithBlobs(".claude/skills/");
  const codexBlobs = lsFilesWithBlobs(".codex/skills/");

  const claudeByRel = new Map([...claudeBlobs.keys()].map((f) => [f.slice(".claude/skills/".length), f]));
  const codexByRel = new Map([...codexBlobs.keys()].map((f) => [f.slice(".codex/skills/".length), f]));

  it("finds tracked skill files on both sides (sanity)", () => {
    expect(claudeBlobs.size).toBeGreaterThan(0);
    expect(codexBlobs.size).toBeGreaterThan(0);
  });

  it("every .codex/skills file that has a .claude/skills counterpart is content-identical (EOL-normalized)", () => {
    const drifted: string[] = [];
    for (const [rel, claudePath] of claudeByRel) {
      const codexPath = codexByRel.get(rel);
      if (!codexPath) continue; // one-sided — covered by the symmetry checks below
      // Equal index blobs = identical bytes; only fetch content on hash mismatch
      // (then normalize EOLs, so a CRLF-vs-LF-only difference is not drift).
      if (claudeBlobs.get(claudePath) === codexBlobs.get(codexPath)) continue;
      const claudeContent = normalizeEol(indexContent(claudePath));
      const codexContent = normalizeEol(indexContent(codexPath));
      if (claudeContent !== codexContent) drifted.push(rel);
    }
    expect(
      drifted,
      `Committed .codex/skills copies drifted from .claude/skills for: ${drifted.join(", ")}.\n` +
        "Sync them from the .claude source (the .claude side is canonical) and commit both paths.",
    ).toEqual([]);
  });

  // The two trees are fully symmetric today. If a skill is deliberately added to
  // only one side, encode the exception here explicitly instead of deleting the check.
  it("no .claude/skills file is missing its committed .codex/skills mirror", () => {
    const claudeOnly = [...claudeByRel.keys()].filter((rel) => !codexByRel.has(rel));
    expect(
      claudeOnly,
      `Skill files exist under .claude/skills but were never mirrored into .codex/skills: ${claudeOnly.join(", ")}.\n` +
        "Mirror them (Codex shares the same skill set) or list a deliberate exception in this test.",
    ).toEqual([]);
  });

  it("no .codex/skills file exists without a .claude/skills source", () => {
    const codexOnly = [...codexByRel.keys()].filter((rel) => !claudeByRel.has(rel));
    expect(
      codexOnly,
      `Orphaned .codex/skills files with no .claude/skills source: ${codexOnly.join(", ")}.\n` +
        ".claude/skills is canonical — remove the orphan or add the .claude source.",
    ).toEqual([]);
  });
});
