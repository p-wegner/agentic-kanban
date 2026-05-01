interface DiffViewerProps {
  diff: string;
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

export function DiffViewer({ diff, stats }: DiffViewerProps) {
  if (!diff) {
    return (
      <div className="text-sm text-gray-500 italic p-4">
        No changes to show.
      </div>
    );
  }

  const lines = diff.split("\n");

  return (
    <div className="border border-gray-300 rounded overflow-hidden">
      <div className="flex items-center gap-4 px-3 py-1.5 bg-gray-50 border-b border-gray-200 text-xs text-gray-600">
        <span>{stats.filesChanged} file{stats.filesChanged !== 1 ? "s" : ""} changed</span>
        <span className="text-green-600">+{stats.insertions}</span>
        <span className="text-red-600">-{stats.deletions}</span>
      </div>
      <div className="overflow-auto max-h-96 bg-gray-50">
        <pre className="text-xs font-mono">
          {lines.map((line, i) => {
            let className = "px-2 ";
            if (line.startsWith("+++ ") || line.startsWith("--- ")) {
              className += "bg-purple-50 text-purple-800 font-semibold";
            } else if (line.startsWith("@@")) {
              className += "bg-blue-50 text-blue-700";
            } else if (line.startsWith("+")) {
              className += "bg-green-50 text-green-800";
            } else if (line.startsWith("-")) {
              className += "bg-red-50 text-red-800";
            } else {
              className += "text-gray-700";
            }
            return (
              <div key={i} className={className}>
                {line || " "}
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}
