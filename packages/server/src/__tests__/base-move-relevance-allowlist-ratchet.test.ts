// @gate:always-run when:packages/**/__tests__/**,packages/server/src/services/base-move-relevance.ts — reads every always-run suite's source to check none names an allowlisted path; imports none of them.
/**
 * `services/base-move-relevance.ts` keeps a passed gate across a base move that touched only
 * allowlisted paths, on the claim that no gate input reads them. The `@gate:always-run` guard
 * suites are the gate inputs that read repo files by path, so this ratchet checks the claim
 * against them: a guard suite whose string literals name an allowlisted file or directory fails
 * here unless it is listed in {@link KNOWN_MENTIONS} with the reason the mention is not a read (or
 * why the read cannot change a verdict). When a guard starts READING one of these paths, take
 * the path off the allowlist instead of adding an exemption.
 *
 * AST-based (string and template literal nodes only), so comments never count and a line wrap
 * cannot hide a mention.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import ts from "typescript";
import {
  forEachNode,
  packagesRootFrom,
  parseGuardSource,
  readGuardSource,
  walkTestFiles,
} from "../../../shared/__tests__/helpers/guard-scan.js";
import { isAlwaysRunMarked } from "../../../../scripts/test-mine.mjs";
import { VERDICT_NEUTRAL_DOC_DIRS, VERDICT_NEUTRAL_FILES } from "../services/base-move-relevance.js";

const packagesRoot = packagesRootFrom(import.meta.dirname!, 3);

const SCAN_PACKAGES = [
  { label: "shared", testsDir: path.join(packagesRoot, "shared", "__tests__") },
  { label: "server", testsDir: path.join(packagesRoot, "server", "src", "__tests__") },
  { label: "mcp-server", testsDir: path.join(packagesRoot, "mcp-server", "src", "__tests__") },
  { label: "client", testsDir: path.join(packagesRoot, "client", "src", "__tests__") },
];

/** `label/<path under __tests__>` → the allowlist entries it may mention, and why that is safe. */
const KNOWN_MENTIONS: Record<string, { entries: string[]; reason: string }> = {
  "server/objective-capacity-hold-ratchet.test.ts": {
    entries: ["scripts/board-monitor/objective.md"],
    reason: "a real reader (#1029), but marked `when:` objective.md, so it runs only for a branch that touches the file "
      + "— and classifyBaseMove discards whenever the branch touches a moved path. Its verdict depends on objective.md "
      + "alone, i.e. on the base's own state, never on the branch.",
  },
  "server/check-arch-scoping.test.mjs": {
    entries: ["docs/state.md", "CONTINUE.md"],
    reason: "a changed-file FIXTURE for check-arch's step scoping; nothing reads the files",
  },
  "server/stop-hook-content-dirty.test.ts": {
    entries: ["docs/state.md"],
    reason: "a fake `git diff` output line fed to the Stop hook's parser; nothing reads the file",
  },
  "shared/lint-arch-gate.test.ts": {
    entries: ["CONTINUE.md"],
    reason: "a pointer inside an error-hint message string; nothing reads the file",
  },
};

/** Does a literal's text name an allowlist entry? A file by basename, a directory by its path or its last segment alone. */
function mentions(text: string, entry: string): boolean {
  if (entry.endsWith("/")) {
    const dir = entry.slice(0, -1);
    return text.includes(dir) || text === dir.split("/").pop();
  }
  return text.includes(path.posix.basename(entry));
}

const ENTRIES = [...VERDICT_NEUTRAL_FILES, ...VERDICT_NEUTRAL_DOC_DIRS];

function scan(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const { label, testsDir } of SCAN_PACKAGES) {
    for (const full of walkTestFiles(testsDir)) {
      const source = readGuardSource(full);
      if (!isAlwaysRunMarked(source)) continue;
      const key = `${label}/${path.relative(testsDir, full).replace(/\\/g, "/")}`;
      if (key === "server/base-move-relevance-allowlist-ratchet.test.ts") continue;
      forEachNode(parseGuardSource(full, source), (node) => {
        const text = ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
          ? node.text
          : null;
        if (text === null) return;
        for (const entry of ENTRIES) {
          if (!mentions(text, entry)) continue;
          if (!found.has(key)) found.set(key, new Set());
          found.get(key)!.add(entry);
        }
      });
    }
  }
  return found;
}

describe("base-move verdict-neutral allowlist is not read by a guard suite", () => {
  const found = scan();

  it("no always-run suite names an allowlisted path without a recorded reason", () => {
    const unexplained: string[] = [];
    for (const [key, entries] of found) {
      const allowed = new Set(KNOWN_MENTIONS[key]?.entries ?? []);
      for (const entry of entries) if (!allowed.has(entry)) unexplained.push(`${key} names ${entry}`);
    }
    expect(
      unexplained,
      "An @gate:always-run suite names a path base-move-relevance.ts treats as verdict-neutral. If it READS the "
        + "path, remove the path from VERDICT_NEUTRAL_FILES / VERDICT_NEUTRAL_DOC_DIRS; if the mention is not a read, "
        + "add it to KNOWN_MENTIONS with the reason.",
    ).toEqual([]);
  });

  it("KNOWN_MENTIONS entries are not stale", () => {
    const stale: string[] = [];
    for (const [key, { entries }] of Object.entries(KNOWN_MENTIONS)) {
      for (const entry of entries) if (!found.get(key)?.has(entry)) stale.push(`${key} → ${entry}`);
    }
    expect(stale, "Remove KNOWN_MENTIONS entries that no longer match").toEqual([]);
  });
});
