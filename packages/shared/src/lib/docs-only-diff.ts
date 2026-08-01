// Docs-only diff detection (#198): the pre-merge boot/render smoke check exists to catch a
// broken boot path, which a documentation-only change can never affect. Skipping it for such
// diffs is cheap and removes an unnecessary source of flaky merge-gate friction (a fixed smoke
// window failing on an unrelated cold-JVM-boot diff).
//
// Pure string logic, no Node builtins — safe as a value export for the client bundle.

const DOCS_ONLY_EXTENSIONS = /\.(md|mdx|txt|rst|adoc)$/i;
const DOCS_ONLY_NAMES = /^(license|licence|changelog|notice|authors|contributing)(\.[a-z0-9]+)?$/i;

function isDocsOnlyFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  if (DOCS_ONLY_EXTENSIONS.test(normalized)) return true;
  if (DOCS_ONLY_NAMES.test(base)) return true;
  if (/(^|\/)docs\//i.test(normalized)) return true;
  return false;
}

/**
 * True when every changed file is documentation (never affects boot/runtime behavior) —
 * markdown/txt/rst/adoc, anything under a `docs/` directory, or a root LICENSE/CHANGELOG/
 * NOTICE/AUTHORS/CONTRIBUTING file. An empty file list is NOT docs-only (nothing changed is
 * not the same claim as "only docs changed") — callers should not use this to skip a gate
 * when the diff couldn't be determined.
 */
export function isDocsOnlyDiff(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every(isDocsOnlyFile);
}
