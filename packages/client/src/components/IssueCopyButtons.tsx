import { useState } from "react";

/** Copies an issue reference string to the clipboard, with a transient check. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy issue reference"}
      className="text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 p-0.5 rounded transition-colors relative"
    >
      {copied ? (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
      {copied && (
        <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-xs bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-800 px-1.5 py-0.5 rounded whitespace-nowrap pointer-events-none">
          Copied!
        </span>
      )}
    </button>
  );
}

/** Copies a shareable `?issue=N` deep link to the clipboard. */
export function CopyLinkButton({ issueNumber }: { issueNumber: number }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = new URL(window.location.href);
    url.search = `?issue=${issueNumber}`;
    navigator.clipboard.writeText(url.toString()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={handleCopy}
      title={copied ? "Link copied!" : "Copy shareable link"}
      aria-label={copied ? "Link copied!" : "Copy shareable link"}
      className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 p-0.5 rounded transition-colors relative"
    >
      {copied ? (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      )}
      {copied && (
        <span className="absolute -bottom-7 left-1/2 -translate-x-1/2 text-xs bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-800 px-1.5 py-0.5 rounded whitespace-nowrap pointer-events-none z-10">
          Copied!
        </span>
      )}
    </button>
  );
}
