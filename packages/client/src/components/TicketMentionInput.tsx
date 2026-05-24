import { useState, useRef, useMemo, useCallback, type KeyboardEvent, type ClipboardEvent } from "react";
import { useMentionContext } from "../lib/MentionContext";

interface TicketMentionInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  inputRef?: React.Ref<HTMLTextAreaElement>;
}

const MENTION_REGEX = /(?:^|[\s(\[{,;])#(\d*)$/;

export default function TicketMentionInput({
  value,
  onChange,
  placeholder,
  rows,
  className,
  disabled,
  autoFocus,
  onPaste,
  onKeyDown,
  inputRef,
}: TicketMentionInputProps) {
  const { issues } = useMentionContext();
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = (inputRef as React.RefObject<HTMLTextAreaElement>) ?? internalRef;

  const [mentionActive, setMentionActive] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const [highlightIdx, setHighlightIdx] = useState(0);

  const filteredIssues = useMemo(() => {
    if (!mentionActive) return [];
    const q = mentionQuery.toLowerCase();
    return issues
      .filter((issue) => {
        if (!q) return true;
        const numStr = String(issue.issueNumber ?? "");
        return (
          numStr.startsWith(q) ||
          issue.title.toLowerCase().includes(q)
        );
      })
      .slice(0, 10);
  }, [issues, mentionActive, mentionQuery]);

  const detectMention = useCallback(
    (val: string, cursorPos: number) => {
      const textBefore = val.slice(0, cursorPos);
      const match = textBefore.match(MENTION_REGEX);
      if (match) {
        const query = match[1];
        // Find the actual # position — it's at match.index + length of the prefix group
        const hashIndex = match.index! + (match[0].length - query.length - 1);
        setMentionActive(true);
        setMentionQuery(query);
        setMentionStartIndex(hashIndex);
        setHighlightIdx(0);
      } else {
        setMentionActive(false);
      }
    },
    [],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newVal = e.target.value;
      onChange(newVal);
      detectMention(newVal, e.target.selectionStart ?? newVal.length);
    },
    [onChange, detectMention],
  );

  const handleSelect = useCallback(
    (issue: { id: string; issueNumber: number | null }) => {
      const mention = `#${issue.issueNumber}`;
      const cursorPos =
        textareaRef.current?.selectionStart ?? value.length;
      const before = value.slice(0, mentionStartIndex);
      const after = value.slice(cursorPos);
      const newVal = before + mention + " " + after;
      onChange(newVal);
      setMentionActive(false);

      const newCursorPos = before.length + mention.length + 1;
      requestAnimationFrame(() => {
        const input = textareaRef.current;
        if (input) {
          input.focus();
          input.setSelectionRange(newCursorPos, newCursorPos);
        }
      });
    },
    [value, mentionStartIndex, onChange, textareaRef],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionActive && filteredIssues.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHighlightIdx((prev) =>
            Math.min(prev + 1, filteredIssues.length - 1),
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHighlightIdx((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const item = filteredIssues[highlightIdx];
          if (item) handleSelect(item);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionActive(false);
          return;
        }
      }
      onKeyDown?.(e);
    },
    [mentionActive, filteredIssues, highlightIdx, handleSelect, onKeyDown],
  );

  const wrapperRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={wrapperRef} className="relative">
      <textarea
        ref={textareaRef as React.LegacyRef<HTMLTextAreaElement>}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        rows={rows}
        className={className}
        disabled={disabled}
        autoFocus={autoFocus}
        onBlur={(e) => {
          // Close dropdown if focus leaves the wrapper
          if (
            !wrapperRef.current?.contains(
              e.relatedTarget as Node,
            )
          ) {
            setMentionActive(false);
          }
        }}
      />
      {mentionActive && (
        <div className="absolute z-50 top-full left-0 mt-0.5 w-72 bg-white border border-gray-200 rounded shadow-lg max-h-48 overflow-y-auto">
          {filteredIssues.length === 0 ? (
            <div className="text-xs text-gray-400 px-2 py-1.5">
              No tickets found
            </div>
          ) : (
            filteredIssues.map((issue, idx) => (
              <button
                key={issue.id}
                tabIndex={-1}
                className={`w-full text-left text-xs px-2 py-1.5 truncate ${
                  idx === highlightIdx
                    ? "bg-blue-100 text-blue-800"
                    : "hover:bg-gray-100"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(issue);
                }}
                onMouseEnter={() => setHighlightIdx(idx)}
              >
                {issue.issueNumber != null ? (
                  <span className="font-mono text-gray-500">
                    #{issue.issueNumber}
                  </span>
                ) : null}
                <span className="ml-1">{issue.title}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
