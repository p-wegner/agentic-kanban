/**
 * Shared keyword extraction utility for failure-pattern similarity matching.
 * Exported from @agentic-kanban/shared so both the server and mcp-server can use it.
 */

const STOP_WORDS = new Set([
  "a","an","the","is","it","in","on","at","to","for","of","and","or","but","not",
  "with","from","by","this","that","was","are","be","as","if","so","we","you",
  "i","he","she","they","then","than","when","where","what","how","which","who",
  "have","has","had","do","does","did","will","would","could","should","may",
  "might","must","can","let","get","got","set","run","use","its","our","your",
]);

/** Extract meaningful tokens from arbitrary text for keyword indexing/matching. */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-./]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i);
}
