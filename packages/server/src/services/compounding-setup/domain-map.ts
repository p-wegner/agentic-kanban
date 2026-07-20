// Short, deterministic domain map for a project that has accumulated enough code (#127).
//
// One output of the compounding "setup once" pass: a builder opening a fresh worktree
// should be able to read ONE small file and know where the code lives, how to run it,
// and which harness files the board already put in place — instead of spending its
// first 20k tokens re-globbing the repo. Every builder rediscovering this from scratch
// is the cold-start tax the fleet analysis measured (median builder context 65k).
//
// Deliberately NOT an LLM summary: it is derived from the filesystem + the persisted
// stack profile, so it is cheap, reproducible, and never hallucinates a module that
// doesn't exist. It states facts and points at code; interpretation is the builder's job.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StackProfile } from "@agentic-kanban/shared";

/** Repo-relative path of the generated domain map. */
export const DOMAIN_MAP_PATH = ".claude/domain-map.md";

/** A top-level source area of the repo, as observed on disk. */
export interface DomainMapEntry {
  /** Repo-relative directory, e.g. "packages/server/src". */
  path: string;
  /** Number of source files directly under it (non-recursive count of its children). */
  childCount: number;
}

export interface DomainMapInput {
  projectName: string;
  profile: StackProfile | null;
  entries: DomainMapEntry[];
  /** Harness files the pass has put in place, repo-relative (rendered as "you inherit these"). */
  harnessFiles: string[];
  generatedAt: string;
}

/** Directories that carry no domain signal and would only pad the map. */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".claude", ".codex", ".pi", ".kanban", ".worktrees",
  "dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".venv", "venv",
  "__pycache__", ".gradle", ".idea", ".vscode", "vendor", "tmp", ".turbo", ".cache",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go", ".py",
  ".java", ".kt", ".kts", ".rb", ".ex", ".exs", ".swift", ".cs", ".php",
]);

function isSourceFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot));
}

/**
 * Walk the repo shallowly (depth 2) and report the directories that actually hold source.
 *
 * Depth 2 is the sweet spot for the layouts the board drives: it sees `src/services` in a
 * flat repo and `packages/server` in a monorepo, without descending into the long tail that
 * would turn the map into a file listing. Non-throwing — an unreadable directory is skipped,
 * because a partial map is still worth writing.
 */
export function collectDomainMapEntries(repoPath: string, maxEntries = 12): DomainMapEntry[] {
  const entries: DomainMapEntry[] = [];

  const scan = (relDir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(join(repoPath, relDir || "."));
    } catch {
      return;
    }

    let sourceCount = 0;
    const subDirs: string[] = [];
    for (const name of names) {
      if (IGNORED_DIRS.has(name) || name.startsWith(".")) continue;
      const abs = join(repoPath, relDir, name);
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) subDirs.push(name);
      else if (isSourceFile(name)) sourceCount++;
    }

    if (relDir && sourceCount > 0) entries.push({ path: relDir.replace(/\\/g, "/"), childCount: sourceCount });
    if (depth <= 0) return;
    for (const sub of subDirs) scan(relDir ? `${relDir}/${sub}` : sub, depth - 1);
  };

  scan("", 2);
  // Densest areas first — that ranking is the only editorial judgement the map makes.
  return entries.sort((a, b) => b.childCount - a.childCount || a.path.localeCompare(b.path)).slice(0, maxEntries);
}

function commandLines(profile: StackProfile | null): string[] {
  if (!profile) return ["- _No stack profile detected yet — run the project's own scripts._"];
  const rows: Array<[string, string | null]> = [
    ["Install", profile.installCommand],
    ["Quick test", profile.quickTestCommand],
    ["Full test", profile.testCommand],
    ["Build", profile.buildCommand],
    ["Typecheck", profile.typecheckCommand],
    ["Lint", profile.lintCommand],
    ["Dev server", profile.devCommand],
  ];
  const lines = rows.filter(([, cmd]) => cmd).map(([label, cmd]) => `- **${label}:** \`${cmd}\``);
  return lines.length > 0 ? lines : ["- _No commands detected for this stack._"];
}

/**
 * Render the domain map. Pure — every fact arrives as input, so the output is testable
 * without a filesystem and identical for identical input (bar the timestamp).
 */
export function buildDomainMap(input: DomainMapInput): string {
  const { projectName, profile, entries, harnessFiles, generatedAt } = input;
  const stack = profile?.stack ?? "unknown";
  const pm = profile?.packageManager ? ` · ${profile.packageManager}` : "";
  const mono = profile?.isMonorepo ? " · monorepo" : "";

  const lines: string[] = [
    `# Domain map — ${projectName}`,
    "",
    "<!-- Generated by the agentic-kanban compounding setup pass. Machine-written; safe to",
    "     extend by hand — a later pass appends nothing and never rewrites an edited file. -->",
    "",
    `Generated ${generatedAt} · stack: **${stack}**${pm}${mono}`,
    "",
    "Read this first. It exists so you don't have to re-derive the layout of this repo",
    "before starting work — that rediscovery is the single largest cold-start cost per ticket.",
    "",
    "## Feedback commands",
    "",
    ...commandLines(profile),
    "",
    "## Where the code lives",
    "",
  ];

  if (entries.length === 0) {
    lines.push("_No source directories detected — the repo may still be mostly empty._");
  } else {
    lines.push("| Directory | Source files |", "| --- | --- |");
    for (const entry of entries) lines.push(`| \`${entry.path}\` | ${entry.childCount} |`);
  }

  lines.push("", "## Tests", "");
  lines.push(profile?.testDir
    ? `Tests live in \`${profile.testDir}\`${profile.testRunner ? ` and run under **${profile.testRunner}**` : ""}.`
    : "_No test directory detected — check the project's test command for where it looks._");

  if (harnessFiles.length > 0) {
    lines.push("", "## Harness you inherit", "",
      "The board already set these up for this project — use them instead of re-inventing them:", "");
    for (const file of harnessFiles) lines.push(`- \`${file}\``);
  }

  lines.push("");
  return lines.join("\n");
}
