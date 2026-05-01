import { useState } from "react";

interface DiffViewerProps {
  diff: string;
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

type ViewMode = "unified" | "split";

interface DiffLine {
  type: "context" | "add" | "delete" | "header" | "hunk";
  content: string;
  lineNumOld?: number;
  lineNumNew?: number;
}

function parseUnifiedDiff(diff: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  return diff.split("\n").map((line) => {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      return { type: "header" as const, content: line };
    }
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1]);
        newLine = parseInt(match[2]);
      }
      return { type: "hunk" as const, content: line };
    }
    if (line.startsWith("+")) {
      return { type: "add" as const, content: line.slice(1), lineNumNew: newLine++ };
    }
    if (line.startsWith("-")) {
      return { type: "delete" as const, content: line.slice(1), lineNumOld: oldLine++ };
    }
    oldLine++;
    newLine++;
    return { type: "context" as const, content: line };
  });
}

function UnifiedView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="overflow-auto max-h-96 bg-gray-50 font-mono text-xs">
      {lines.map((line, i) => {
        let className = "px-2 ";
        if (line.type === "header") {
          className += "bg-purple-50 text-purple-800 font-semibold";
        } else if (line.type === "hunk") {
          className += "bg-blue-50 text-blue-700";
        } else if (line.type === "add") {
          className += "bg-green-50 text-green-800";
        } else if (line.type === "delete") {
          className += "bg-red-50 text-red-800";
        } else {
          className += "text-gray-700";
        }
        return (
          <div key={i} className={className}>
            {line.type === "add" ? "+" : line.type === "delete" ? "-" : " "}
            {line.type === "hunk" || line.type === "header" ? line.content : line.content || " "}
          </div>
        );
      })}
    </div>
  );
}

function SplitView({ lines }: { lines: DiffLine[] }) {
  // Pair up adjacent delete+add lines for side-by-side display
  const pairs: { left: DiffLine | null; right: DiffLine | null }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "delete" && i + 1 < lines.length && lines[i + 1].type === "add") {
      pairs.push({ left: line, right: lines[i + 1] });
      i += 2;
    } else if (line.type === "delete") {
      pairs.push({ left: line, right: null });
      i++;
    } else if (line.type === "add") {
      pairs.push({ left: null, right: line });
      i++;
    } else if (line.type === "header" || line.type === "hunk") {
      pairs.push({ left: line, right: line });
      i++;
    } else {
      pairs.push({ left: line, right: line });
      i++;
    }
  }

  return (
    <div className="overflow-auto max-h-96 bg-gray-50 font-mono text-xs">
      <table className="w-full border-collapse">
        <tbody>
          {pairs.map((pair, idx) => {
            const isHeader = pair.left?.type === "header" || pair.left?.type === "hunk";
            const isFullWidth = isHeader;

            if (isFullWidth && pair.left) {
              const line = pair.left;
              const className = line.type === "header"
                ? "bg-purple-50 text-purple-800 font-semibold"
                : "bg-blue-50 text-blue-700";
              return (
                <tr key={idx}>
                  <td colSpan={4} className={`px-2 py-0 ${className}`}>
                    {line.content || " "}
                  </td>
                </tr>
              );
            }

            return (
              <tr key={idx}>
                <td className={`px-1 text-right text-gray-400 w-8 select-none ${pair.left?.type === "delete" ? "bg-red-50" : ""}`}>
                  {pair.left?.lineNumOld ?? ""}
                </td>
                <td className={`px-2 ${pair.left?.type === "delete" ? "bg-red-50 text-red-800" : "text-gray-700"}`}>
                  {pair.left ? (pair.left.type === "delete" ? pair.left.content : pair.left.content) : ""}
                </td>
                <td className={`px-1 text-right text-gray-400 w-8 select-none border-l border-gray-200 ${pair.right?.type === "add" ? "bg-green-50" : ""}`}>
                  {pair.right?.lineNumNew ?? ""}
                </td>
                <td className={`px-2 ${pair.right?.type === "add" ? "bg-green-50 text-green-800" : "text-gray-700"}`}>
                  {pair.right ? (pair.right.type === "add" ? pair.right.content : pair.right.content) : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DiffViewer({ diff, stats }: DiffViewerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("unified");

  if (!diff) {
    return (
      <div className="text-sm text-gray-500 italic p-4">
        No changes to show.
      </div>
    );
  }

  const lines = parseUnifiedDiff(diff);

  return (
    <div className="border border-gray-300 rounded overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-4 text-xs text-gray-600">
          <span>{stats.filesChanged} file{stats.filesChanged !== 1 ? "s" : ""} changed</span>
          <span className="text-green-600">+{stats.insertions}</span>
          <span className="text-red-600">-{stats.deletions}</span>
        </div>
        <div className="flex items-center bg-gray-200 rounded overflow-hidden">
          <button
            onClick={() => setViewMode("unified")}
            className={`px-2 py-0.5 text-xs ${viewMode === "unified" ? "bg-white shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
          >
            Unified
          </button>
          <button
            onClick={() => setViewMode("split")}
            className={`px-2 py-0.5 text-xs ${viewMode === "split" ? "bg-white shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
          >
            Split
          </button>
        </div>
      </div>
      {viewMode === "unified" ? <UnifiedView lines={lines} /> : <SplitView lines={lines} />}
    </div>
  );
}
