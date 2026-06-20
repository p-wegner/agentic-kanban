import type { DiffComment } from "@agentic-kanban/shared";

const CONTEXT_LINES = 3;

export interface DiffLine {
  type: "context" | "add" | "delete" | "header" | "hunk";
  content: string;
  lineNumOld?: number;
  lineNumNew?: number;
}

export interface DiffFile {
  filePath: string;
  lines: DiffLine[];
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let currentFile: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      const match = line.match(/^\+\+\+ b\/(.+)$/);
      if (match) {
        currentFile = { filePath: match[1], lines: [] };
        files.push(currentFile);
      }
      continue;
    }
    if (line.startsWith("--- ") && !currentFile) {
      continue;
    }
    if (!currentFile) continue;

    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1]);
        newLine = parseInt(match[2]);
      }
      currentFile.lines.push({ type: "hunk", content: line });
    } else if (line.startsWith("+")) {
      currentFile.lines.push({ type: "add", content: line.slice(1), lineNumNew: newLine++ });
    } else if (line.startsWith("-")) {
      currentFile.lines.push({ type: "delete", content: line.slice(1), lineNumOld: oldLine++ });
    } else {
      oldLine++;
      newLine++;
      currentFile.lines.push({ type: "context", content: line });
    }
  }
  return files;
}

export function computeFileStats(lines: DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === "add") additions++;
    if (line.type === "delete") deletions++;
  }
  return { additions, deletions };
}

export interface FileTreeNode {
  name: string;
  fullPath: string;
  isFile: boolean;
  children: FileTreeNode[];
  additions: number;
  deletions: number;
  fileIdx: number;
}

export function buildFileTree(files: DiffFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  for (let i = 0; i < files.length; i++) {
    const { additions, deletions } = computeFileStats(files[i].lines);
    const parts = files[i].filePath.split("/");
    let nodes = root;
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      const isFile = j === parts.length - 1;
      let node = nodes.find(n => n.name === part);
      if (!node) {
        node = { name: part, fullPath: parts.slice(0, j + 1).join("/"), isFile, children: [], additions, deletions, fileIdx: isFile ? i : -1 };
        nodes.push(node);
      } else {
        node.additions += additions;
        node.deletions += deletions;
      }
      nodes = node.children;
    }
  }
  return root;
}

export function commentKey(filePath: string, lineNumOld: number | null | undefined, lineNumNew: number | null | undefined, side: string): string {
  return `${filePath}:${lineNumOld ?? ""}:${lineNumNew ?? ""}:${side}`;
}

export function buildCommentMap(comments: DiffComment[]): Map<string, DiffComment[]> {
  const map = new Map<string, DiffComment[]>();
  for (const c of comments) {
    const key = commentKey(c.filePath, c.lineNumOld, c.lineNumNew, c.side);
    const arr = map.get(key) ?? [];
    arr.push(c);
    map.set(key, arr);
  }
  return map;
}

export interface CollapsibleRegion {
  startIdx: number;
  endIdx: number; // exclusive
  collapsedCount: number;
}

export function computeCollapsibleRegions(lines: DiffLine[]): CollapsibleRegion[] {
  const regions: CollapsibleRegion[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "context") {
      const start = i;
      while (i < lines.length && lines[i].type === "context") i++;
      const len = i - start;
      if (len > CONTEXT_LINES * 2) {
        regions.push({ startIdx: start + CONTEXT_LINES, endIdx: i - CONTEXT_LINES, collapsedCount: len - CONTEXT_LINES * 2 });
      }
    } else {
      i++;
    }
  }
  return regions;
}
