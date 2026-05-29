import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { existsSync } from "node:fs";
import { Project } from "ts-morph";
import { invokeClaudePrompt } from "./claude-cli.service.js";
import { getProjectRepoPath } from "../repositories/agent-skill.repository.js";
import type { Database } from "../db/index.js";
import { ValidationError } from "../errors/index.js";

export const CODEMOD_FILE_LIMIT = 100;

export interface CodemodFileDiff {
  filePath: string;
  relativePath: string;
  original: string;
  modified: string;
  diff: string;
}

export interface CodemodPreviewResult {
  script: string;
  files: CodemodFileDiff[];
  totalTsFiles: number;
  limitReached: boolean;
}

export interface CodemodApplyResult {
  applied: string[];
  skipped: string[];
}

/**
 * Collect all TypeScript/TSX source files in a directory (non-recursive under node_modules, .git, dist).
 */
async function collectTsFiles(repoPath: string): Promise<string[]> {
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__"]);
  const results: string[] = [];

  async function walk(dir: string) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (typeof name !== "string") continue;
      if (name.startsWith(".")) continue;
      const fullPath = join(dir, name);
      let stats;
      try {
        stats = await stat(fullPath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await walk(fullPath);
      } else if (stats.isFile()) {
        const ext = extname(name);
        if (ext === ".ts" || ext === ".tsx") {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(repoPath);
  return results;
}

/**
 * Compute a simple unified diff string from two texts.
 */
function computeUnifiedDiff(original: string, modified: string, filePath: string): string {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");

  if (original === modified) return "";

  const header = `--- a/${filePath}\n+++ b/${filePath}\n`;
  const chunks: string[] = [];

  // Simple line-by-line diff using LCS
  const lcs = computeLcs(origLines, modLines);
  const hunks = buildHunks(origLines, modLines, lcs);

  for (const hunk of hunks) {
    chunks.push(hunk);
  }

  if (chunks.length === 0) return "";
  return header + chunks.join("\n");
}

/** Compute LCS indices for diff generation */
function computeLcs(a: string[], b: string[]): boolean[][] {
  const m = Math.min(a.length, 500); // limit for performance
  const n = Math.min(b.length, 500);
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  // Backtrack to find matching lines
  const matched: boolean[][] = [
    new Array(m).fill(false), // which orig lines are in LCS
    new Array(n).fill(false), // which mod lines are in LCS
  ];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      matched[0][i - 1] = true;
      matched[1][j - 1] = true;
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return matched;
}

function buildHunks(origLines: string[], modLines: string[], lcs: boolean[][]): string[] {
  const MAX_LINES = Math.min(origLines.length, 500);
  const MAX_MOD_LINES = Math.min(modLines.length, 500);

  // Build edit script
  type Edit = { type: "context" | "del" | "add"; line: string; origIdx: number; modIdx: number };
  const edits: Edit[] = [];
  let oi = 0, mi = 0;
  while (oi < MAX_LINES || mi < MAX_MOD_LINES) {
    if (oi < MAX_LINES && mi < MAX_MOD_LINES && origLines[oi] === modLines[mi] && lcs[0][oi] && lcs[1][mi]) {
      edits.push({ type: "context", line: origLines[oi], origIdx: oi, modIdx: mi });
      oi++;
      mi++;
    } else if (oi < MAX_LINES && !lcs[0][oi]) {
      edits.push({ type: "del", line: origLines[oi], origIdx: oi, modIdx: mi });
      oi++;
    } else if (mi < MAX_MOD_LINES && !lcs[1][mi]) {
      edits.push({ type: "add", line: modLines[mi], origIdx: oi, modIdx: mi });
      mi++;
    } else {
      if (oi < MAX_LINES) { edits.push({ type: "del", line: origLines[oi], origIdx: oi, modIdx: mi }); oi++; }
      if (mi < MAX_MOD_LINES) { edits.push({ type: "add", line: modLines[mi], origIdx: oi, modIdx: mi }); mi++; }
    }
  }

  // Group into hunks (changes with 3 lines context)
  const CONTEXT = 3;
  const chunks: string[] = [];
  let i = 0;
  while (i < edits.length) {
    if (edits[i].type === "context") { i++; continue; }
    // Found a change — collect hunk
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    while (end < edits.length && (edits[end].type !== "context" || end - i < CONTEXT)) end++;
    end = Math.min(end + CONTEXT, edits.length);

    const hunkEdits = edits.slice(start, end);
    const origStart = hunkEdits[0].origIdx + 1;
    const modStart = hunkEdits[0].modIdx + 1;
    const origCount = hunkEdits.filter(e => e.type !== "add").length;
    const modCount = hunkEdits.filter(e => e.type !== "del").length;

    const hunkHeader = `@@ -${origStart},${origCount} +${modStart},${modCount} @@`;
    const hunkLines = hunkEdits.map(e => {
      if (e.type === "context") return ` ${e.line}`;
      if (e.type === "del") return `-${e.line}`;
      return `+${e.line}`;
    });
    chunks.push([hunkHeader, ...hunkLines].join("\n"));
    i = end;
  }
  return chunks;
}

/**
 * Generate a ts-morph codemod script (transform function body) from a plain-English description.
 */
export async function generateCodemodScript(
  description: string,
  fileList: string[],
  database: Database,
): Promise<string> {
  const sampleFiles = fileList.slice(0, 10).join("\n");
  const prompt = `You are a TypeScript codemod expert using ts-morph.

The user wants to apply this refactor:
"${description}"

Sample TypeScript files in the project:
${sampleFiles}

Generate ONLY the body of a per-file transform function. The function has access to:
- \`sourceFile\`: a ts-morph SourceFile object — use its methods to find and modify nodes
- All standard ts-morph SourceFile methods are available (getClasses, getInterfaces, getImportDeclarations, getDescendantsOfKind, etc.)

Requirements:
- Only modify \`sourceFile\` — do NOT call \`sourceFile.save()\` or \`project.save()\`
- Do NOT import anything — ts-morph types are already available
- The code runs once per source file
- Be precise and handle edge cases
- Use ts-morph AST methods for correctness (not regex)
- If a file doesn't match the pattern, do nothing (the harness detects unchanged files)

Respond ONLY with the raw JavaScript/TypeScript code body (no function declaration, no \`\`\` fences, no explanation).
Example for "rename all occurrences of OldName class to NewName":
for (const cls of sourceFile.getClasses()) {
  if (cls.getName() === 'OldName') {
    cls.rename('NewName');
  }
}`;

  const stdout = await invokeClaudePrompt(prompt, { database, timeout: 60000 });
  return stdout.trim()
    .replace(/^```(?:typescript|javascript|ts|js)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/**
 * Run a codemod transform in dry-run mode (never writes files).
 * Returns per-file diffs for files that would change.
 */
export async function previewCodemod(
  transformCode: string,
  repoPath: string,
  options: { overrideLimit?: boolean } = {},
): Promise<CodemodPreviewResult> {
  const allTsFiles = await collectTsFiles(repoPath);
  const totalTsFiles = allTsFiles.length;
  let limitReached = false;
  let filesToProcess = allTsFiles;

  if (totalTsFiles > CODEMOD_FILE_LIMIT && !options.overrideLimit) {
    throw new ValidationError(
      `This project has ${totalTsFiles} TypeScript files. Codemods touching more than ${CODEMOD_FILE_LIMIT} files require explicit confirmation. Resend with overrideLimit: true.`,
    );
  }
  if (totalTsFiles > CODEMOD_FILE_LIMIT) {
    limitReached = true;
    filesToProcess = allTsFiles; // still process all when override is set
  }

  // Create ts-morph project for in-memory analysis
  let project: Project;
  const tsConfigPath = join(repoPath, "tsconfig.json");
  if (existsSync(tsConfigPath)) {
    project = new Project({
      tsConfigFilePath: tsConfigPath,
      skipAddingFilesFromTsConfig: false,
      skipFileDependencyResolution: true,
    });
  } else {
    project = new Project({ useInMemoryFileSystem: false });
    for (const filePath of filesToProcess) {
      project.addSourceFileAtPath(filePath);
    }
  }

  // Create transform function using AsyncFunction
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...fnArgs: unknown[]) => Promise<void>;

  let transform: (sourceFile: unknown) => Promise<void>;
  try {
    transform = new AsyncFunction("sourceFile", transformCode);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Invalid codemod script: ${msg}`);
  }

  const fileDiffs: CodemodFileDiff[] = [];
  const sourceFiles = project.getSourceFiles();

  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    // Skip files outside the project directory (e.g. declaration files from node_modules)
    if (!filePath.startsWith(repoPath.replace(/\\/g, "/"))) continue;

    const original = sourceFile.getFullText();
    try {
      await transform(sourceFile);
    } catch {
      // If transform throws for this file, skip it
      continue;
    }
    const modified = sourceFile.getFullText();

    if (original !== modified) {
      const rel = relative(repoPath, filePath.replace(/\//g, "\\")).replace(/\\/g, "/");
      fileDiffs.push({
        filePath,
        relativePath: rel,
        original,
        modified,
        diff: computeUnifiedDiff(original, modified, rel),
      });
    }

    // Reset the file to original text so the project stays clean for subsequent files
    sourceFile.replaceWithText(original);
  }

  return {
    script: transformCode,
    files: fileDiffs,
    totalTsFiles,
    limitReached,
  };
}

/**
 * Apply codemod changes for selected files (write to disk).
 */
export async function applyCodemod(
  changes: Array<{ filePath: string; modified: string }>,
  selectedFiles: string[],
): Promise<CodemodApplyResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const selectedSet = new Set(selectedFiles);

  for (const change of changes) {
    const rel = change.filePath;
    if (selectedFiles.length === 0 || selectedSet.has(rel)) {
      await writeFile(change.filePath, change.modified, "utf8");
      applied.push(rel);
    } else {
      skipped.push(rel);
    }
  }

  return { applied, skipped };
}

export function createCodemodService(database: Database) {
  return {
    async generate(description: string, projectId: string) {
      const repoPath = await getProjectRepoPath(projectId, database);
      if (!repoPath) throw new ValidationError("Project not found or has no repo path");
      const fileList = await collectTsFiles(repoPath);
      const script = await generateCodemodScript(description, fileList, database);
      return { script, repoPath };
    },

    async preview(
      description: string,
      projectId: string,
      options: { overrideLimit?: boolean; script?: string } = {},
    ): Promise<CodemodPreviewResult & { description: string }> {
      const repoPath = await getProjectRepoPath(projectId, database);
      if (!repoPath) throw new ValidationError("Project not found or has no repo path");

      let script = options.script;
      if (!script) {
        const fileList = await collectTsFiles(repoPath);
        script = await generateCodemodScript(description, fileList, database);
      }

      const result = await previewCodemod(script, repoPath, { overrideLimit: options.overrideLimit });
      return { ...result, description };
    },

    async apply(
      changes: Array<{ filePath: string; modified: string }>,
      selectedFiles: string[],
    ): Promise<CodemodApplyResult> {
      return applyCodemod(changes, selectedFiles);
    },
  };
}
