import { useState } from "react";

/** A command in a code block with a copy button (#1370). */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="flex items-start gap-2 rounded bg-gray-100 dark:bg-gray-800 px-2 py-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs text-ink dark:text-stone-100">{command}</code>
      <button
        type="button"
        onClick={copy}
        title="Copy command"
        className="shrink-0 rounded border border-gray-300 dark:border-gray-600 px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
