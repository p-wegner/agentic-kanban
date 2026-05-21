import { useState, useRef, useEffect, Fragment } from "react";
import type { DiffComment, CreateDiffCommentRequest } from "@agentic-kanban/shared";

interface DiffViewerProps {
  diff: string;
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  comments?: DiffComment[];
  onCreateComment?: (data: CreateDiffCommentRequest) => void;
  onEditComment?: (commentId: string, body: string) => void;
  onDeleteComment?: (commentId: string) => void;
}

type ViewMode = "unified" | "split";

interface DiffLine {
  type: "context" | "add" | "delete" | "header" | "hunk";
  content: string;
  lineNumOld?: number;
  lineNumNew?: number;
}

interface DiffFile {
  filePath: string;
  lines: DiffLine[];
}

function parseUnifiedDiff(diff: string): DiffFile[] {
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

function computeFileStats(lines: DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === "add") additions++;
    if (line.type === "delete") deletions++;
  }
  return { additions, deletions };
}

function commentKey(filePath: string, lineNumOld: number | null | undefined, lineNumNew: number | null | undefined, side: string): string {
  return `${filePath}:${lineNumOld ?? ""}:${lineNumNew ?? ""}:${side}`;
}

function buildCommentMap(comments: DiffComment[]): Map<string, DiffComment[]> {
  const map = new Map<string, DiffComment[]>();
  for (const c of comments) {
    const key = commentKey(c.filePath, c.lineNumOld, c.lineNumNew, c.side);
    const arr = map.get(key) ?? [];
    arr.push(c);
    map.set(key, arr);
  }
  return map;
}

function CommentBlock({
  comment,
  onEdit,
  onDelete,
}: {
  comment: DiffComment;
  onEdit?: (id: string, body: string) => void;
  onDelete?: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [editing]);

  if (editing) {
    return (
      <div className="bg-yellow-50 border-l-2 border-yellow-400 px-3 py-2 flex items-start gap-2">
        <textarea
          ref={textareaRef}
          value={editBody}
          onChange={(e) => setEditBody(e.target.value)}
          className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 resize-none min-h-[40px]"
          rows={2}
        />
        <div className="flex flex-col gap-1">
          <button
            onClick={() => { onEdit?.(comment.id, editBody); setEditing(false); }}
            className="text-xs px-2 py-0.5 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Save
          </button>
          <button
            onClick={() => { setEditBody(comment.body); setEditing(false); }}
            className="text-xs px-2 py-0.5 text-gray-500 hover:text-gray-700"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const timestamp = new Date(comment.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="bg-yellow-50 border-l-2 border-yellow-400 px-3 py-1.5 group/comment">
      <div className="flex items-center gap-2 mb-0.5">
        <span className="text-[10px] text-gray-400">{timestamp}</span>
      </div>
      <div className="text-xs text-gray-700 whitespace-pre-wrap">{comment.body}</div>
      <div className="flex items-center gap-2 mt-0.5 opacity-0 group-hover/comment:opacity-100 transition-opacity">
        <button
          onClick={() => setEditing(true)}
          className="text-[10px] text-gray-400 hover:text-gray-600"
        >
          Edit
        </button>
        <button
          onClick={() => onDelete?.(comment.id)}
          className="text-[10px] text-red-400 hover:text-red-600"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function CommentInput({
  onSubmit,
  onCancel,
}: {
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="bg-blue-50 border-l-2 border-blue-400 px-3 py-2">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write a comment..."
        className="w-full text-xs border border-gray-300 rounded px-2 py-1 resize-none min-h-[40px]"
        rows={2}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && body.trim()) {
            e.preventDefault();
            onSubmit(body.trim());
          }
        }}
      />
      <div className="flex items-center gap-2 mt-1">
        <button
          onClick={() => { if (body.trim()) onSubmit(body.trim()); }}
          disabled={!body.trim()}
          className="text-xs px-2 py-0.5 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
        >
          Comment
        </button>
        <button
          onClick={onCancel}
          className="text-xs px-2 py-0.5 text-gray-500 hover:text-gray-700"
        >
          Cancel
        </button>
        <span className="text-[10px] text-gray-400 ml-auto">Ctrl+Enter to submit</span>
      </div>
    </div>
  );
}

function UnifiedFileView({
  file,
  commentMap,
  onCreateComment,
  onEditComment,
  onDeleteComment,
}: {
  file: DiffFile;
  commentMap: Map<string, DiffComment[]>;
  onCreateComment?: (data: CreateDiffCommentRequest) => void;
  onEditComment?: (id: string, body: string) => void;
  onDeleteComment?: (id: string) => void;
}) {
  const [inputLineIdx, setInputLineIdx] = useState<number | null>(null);

  return (
    <div className="overflow-auto max-h-80 bg-gray-50 font-mono text-xs">
      {file.lines.map((line, li) => {
        const isCommentable = line.type !== "header" && line.type !== "hunk";
        const side = line.type === "delete" ? "old" : "new";
        const cKey = isCommentable
          ? commentKey(file.filePath, line.lineNumOld, line.lineNumNew, side)
          : "";
        const lineComments = isCommentable ? (commentMap.get(cKey) ?? []) : [];
        const isInputOpen = inputLineIdx === li;

        let className = "px-2 relative group/line ";
        if (line.type === "hunk") {
          className += "bg-blue-50 text-blue-700";
        } else if (line.type === "add") {
          className += "bg-green-50 text-green-800";
        } else if (line.type === "delete") {
          className += "bg-red-50 text-red-800";
        } else {
          className += "text-gray-700";
        }

        return (
          <Fragment key={li}>
            <div
              className={className}
              onClick={() => {
                if (isCommentable && onCreateComment) setInputLineIdx(li);
              }}
            >
              {line.type === "add" ? "+" : line.type === "delete" ? "-" : " "}
              {line.type === "hunk" ? line.content : line.content || " "}
              {isCommentable && onCreateComment && lineComments.length === 0 && !isInputOpen && (
                <span className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/line:opacity-100 transition-opacity cursor-pointer select-none w-5 h-5 flex items-center justify-center rounded-full bg-gray-200 hover:bg-blue-200 text-gray-500 hover:text-blue-600 text-sm leading-none">
                  +
                </span>
              )}
              {lineComments.length > 0 && (
                <span className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full bg-yellow-200 text-yellow-700 text-xs font-medium select-none">
                  {lineComments.length}
                </span>
              )}
            </div>
            {lineComments.map((c) => (
              <CommentBlock key={c.id} comment={c} onEdit={onEditComment} onDelete={onDeleteComment} />
            ))}
            {isInputOpen && (
              <CommentInput
                onSubmit={(body) => {
                  onCreateComment?.({
                    filePath: file.filePath,
                    lineNumOld: line.lineNumOld ?? null,
                    lineNumNew: line.lineNumNew ?? null,
                    side,
                    body,
                  });
                  setInputLineIdx(null);
                }}
                onCancel={() => setInputLineIdx(null)}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function SplitFileView({
  file,
  commentMap,
  onCreateComment,
  onEditComment,
  onDeleteComment,
}: {
  file: DiffFile;
  commentMap: Map<string, DiffComment[]>;
  onCreateComment?: (data: CreateDiffCommentRequest) => void;
  onEditComment?: (id: string, body: string) => void;
  onDeleteComment?: (id: string) => void;
}) {
  const [inputLineIdx, setInputLineIdx] = useState<number | null>(null);

  const pairs: { left: DiffLine | null; right: DiffLine | null; lineIdx: number }[] = [];
  let i = 0;
  while (i < file.lines.length) {
    const line = file.lines[i];
    if (line.type === "delete" && i + 1 < file.lines.length && file.lines[i + 1].type === "add") {
      pairs.push({ left: line, right: file.lines[i + 1], lineIdx: i });
      i += 2;
    } else if (line.type === "delete") {
      pairs.push({ left: line, right: null, lineIdx: i });
      i++;
    } else if (line.type === "add") {
      pairs.push({ left: null, right: line, lineIdx: i });
      i++;
    } else {
      pairs.push({ left: line, right: line, lineIdx: i });
      i++;
    }
  }

  return (
    <div className="overflow-auto max-h-80 bg-gray-50 font-mono text-xs">
      <table className="w-full border-collapse">
        <tbody>
          {pairs.map((pair) => {
            const isHeader = pair.left?.type === "hunk";

            if (isHeader && pair.left) {
              return (
                <tr key={pair.lineIdx}>
                  <td colSpan={4} className="px-2 py-0 bg-blue-50 text-blue-700">
                    {pair.left.content || " "}
                  </td>
                </tr>
              );
            }

            const isCommentable = pair.left?.type !== "hunk" && pair.left?.type !== "header";
            const allComments: DiffComment[] = [];
            if (isCommentable) {
              if (pair.left?.type === "delete") {
                const oldK = commentKey(file.filePath, pair.left.lineNumOld, null, "old");
                allComments.push(...(commentMap.get(oldK) ?? []));
              }
              if (pair.right?.type === "add") {
                const newK = commentKey(file.filePath, null, pair.right.lineNumNew, "new");
                allComments.push(...(commentMap.get(newK) ?? []));
              }
              if (pair.left?.type === "context") {
                const ctxK = commentKey(file.filePath, pair.left.lineNumOld, pair.left.lineNumNew, "new");
                allComments.push(...(commentMap.get(ctxK) ?? []));
              }
            }
            const isInputOpen = inputLineIdx === pair.lineIdx;

            return (
              <Fragment key={pair.lineIdx}>
                <tr
                  className="group/line"
                  onClick={() => {
                    if (isCommentable && onCreateComment) setInputLineIdx(pair.lineIdx);
                  }}
                >
                  <td className={`px-1 text-right text-gray-400 w-8 select-none ${pair.left?.type === "delete" ? "bg-red-50" : ""}`}>
                    {pair.left?.lineNumOld ?? ""}
                  </td>
                  <td className={`px-2 ${pair.left?.type === "delete" ? "bg-red-50 text-red-800" : "text-gray-700"}`}>
                    {pair.left ? pair.left.content : ""}
                  </td>
                  <td className={`px-1 text-right text-gray-400 w-8 select-none border-l border-gray-200 ${pair.right?.type === "add" ? "bg-green-50" : ""}`}>
                    {pair.right?.lineNumNew ?? ""}
                  </td>
                  <td className={`px-2 ${pair.right?.type === "add" ? "bg-green-50 text-green-800" : "text-gray-700"}`}>
                    {pair.right ? pair.right.content : ""}
                  </td>
                </tr>
                {allComments.map((c) => (
                  <tr key={c.id}>
                    <td colSpan={4}>
                      <CommentBlock comment={c} onEdit={onEditComment} onDelete={onDeleteComment} />
                    </td>
                  </tr>
                ))}
                {isInputOpen && (
                  <tr>
                    <td colSpan={4}>
                      <CommentInput
                        onSubmit={(body) => {
                          const side = pair.left?.type === "delete" ? "old" : "new";
                          onCreateComment?.({
                            filePath: file.filePath,
                            lineNumOld: pair.left?.lineNumOld ?? null,
                            lineNumNew: pair.right?.lineNumNew ?? null,
                            side,
                            body,
                          });
                          setInputLineIdx(null);
                        }}
                        onCancel={() => setInputLineIdx(null)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FileDiffAccordion({
  file,
  fileIdx,
  expanded,
  onToggle,
  viewMode,
  commentMap,
  onCreateComment,
  onEditComment,
  onDeleteComment,
}: {
  file: DiffFile;
  fileIdx: number;
  expanded: boolean;
  onToggle: () => void;
  viewMode: ViewMode;
  commentMap: Map<string, DiffComment[]>;
  onCreateComment?: (data: CreateDiffCommentRequest) => void;
  onEditComment?: (id: string, body: string) => void;
  onDeleteComment?: (id: string) => void;
}) {
  const { additions, deletions } = computeFileStats(file.lines);

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-100 hover:bg-gray-200 cursor-pointer select-none transition-colors text-left"
      >
        <svg
          className={`w-3.5 h-3.5 text-gray-500 shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-xs font-mono text-gray-700 truncate flex-1 min-w-0" title={file.filePath}>
          {file.filePath}
        </span>
        <span className="text-xs text-green-600 font-medium shrink-0">+{additions}</span>
        <span className="text-xs text-red-600 font-medium shrink-0">-{deletions}</span>
      </button>
      {expanded && (
        viewMode === "unified" ? (
          <UnifiedFileView file={file} commentMap={commentMap} onCreateComment={onCreateComment} onEditComment={onEditComment} onDeleteComment={onDeleteComment} />
        ) : (
          <SplitFileView file={file} commentMap={commentMap} onCreateComment={onCreateComment} onEditComment={onEditComment} onDeleteComment={onDeleteComment} />
        )
      )}
    </div>
  );
}

export function DiffViewer({ diff, stats, comments = [], onCreateComment, onEditComment, onDeleteComment }: DiffViewerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("unified");
  const files = parseUnifiedDiff(diff);
  const commentMap = buildCommentMap(comments);

  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(() => new Set(files.map((_, i) => i)));

  useEffect(() => {
    setExpandedFiles(new Set(files.map((_, i) => i)));
  }, [diff]);

  const allExpanded = expandedFiles.size === files.length;

  if (!diff) {
    return (
      <div className="text-sm text-gray-500 italic p-4">
        No changes to show.
      </div>
    );
  }

  return (
    <div className="border border-gray-300 rounded overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-4 text-xs text-gray-600">
          <span>{stats.filesChanged} file{stats.filesChanged !== 1 ? "s" : ""} changed</span>
          <span className="text-green-600">+{stats.insertions}</span>
          <span className="text-red-600">-{stats.deletions}</span>
          {comments.length > 0 && (
            <span className="text-yellow-600">{comments.length} comment{comments.length !== 1 ? "s" : ""}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {files.length > 1 && (
            <button
              onClick={() => {
                if (allExpanded) {
                  setExpandedFiles(new Set());
                } else {
                  setExpandedFiles(new Set(files.map((_, i) => i)));
                }
              }}
              className="text-xs px-2 py-0.5 text-gray-500 hover:text-gray-700"
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </button>
          )}
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
      </div>
      <div className="divide-y divide-gray-200">
        {files.map((file, fi) => (
          <FileDiffAccordion
            key={fi}
            file={file}
            fileIdx={fi}
            expanded={expandedFiles.has(fi)}
            onToggle={() => {
              setExpandedFiles(prev => {
                const next = new Set(prev);
                if (next.has(fi)) next.delete(fi);
                else next.add(fi);
                return next;
              });
            }}
            viewMode={viewMode}
            commentMap={commentMap}
            onCreateComment={onCreateComment}
            onEditComment={onEditComment}
            onDeleteComment={onDeleteComment}
          />
        ))}
      </div>
    </div>
  );
}
