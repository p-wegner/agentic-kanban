// Docs-only diff detection (#198): the pre-merge boot/render smoke check exists to catch a
// broken boot path, which a documentation-only change can never affect. Skipping it for such
// diffs is cheap and removes an unnecessary source of flaky merge-gate friction (a fixed smoke
// window failing on an unrelated cold-JVM-boot diff).
//
// Pure string logic, no Node builtins — safe as a value export for the client bundle.

/**
 * Extensions that are documentation WHEREVER they live.
 *
 * `.txt` is deliberately NOT here (#240): `requirements.txt` is a Python dependency manifest
 * and `CMakeLists.txt` is a build file, so treating the extension as documentation waved a
 * dependency bump or a build change through the entire verify gate with zero verification.
 * A genuinely documentary `.txt` is still covered by the docs/ rule or by the documentation
 * NAMES below (`LICENSE.txt`).
 */
const DOCS_ONLY_EXTENSIONS = /\.(md|mdx|rst|adoc)$/i;

/**
 * Extensions a documentation NAME may carry and still be documentation. Broader than
 * {@link DOCS_ONLY_EXTENSIONS} (it admits `.txt`, e.g. `LICENSE.txt`) but CLOSED — the old
 * `\.[a-z0-9]+` wildcard classified `services/changelog.ts`, `src/notice.py` and
 * `lib/authors.rb` as documentation, which skipped the whole gate for a pure code diff (#240).
 */
const DOCS_NAME_EXTENSIONS = /^\.(md|mdx|txt|rst|adoc)$/i;
const DOCS_ONLY_NAMES = /^(license|licence|changelog|notice|authors|contributing)(\.[a-z0-9]+)?$/i;

/** True for a documentation basename carrying either no extension at all or a documentation one. */
function isDocsOnlyName(base: string): boolean {
  if (!DOCS_ONLY_NAMES.test(base)) return false;
  const dot = base.indexOf(".");
  if (dot === -1) return true; // LICENSE, NOTICE, AUTHORS — extensionless
  return DOCS_NAME_EXTENSIONS.test(base.slice(dot));
}

function isDocsOnlyFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  if (DOCS_ONLY_EXTENSIONS.test(normalized)) return true;
  if (isDocsOnlyName(base)) return true;
  if (/(^|\/)docs\//i.test(normalized)) return true;
  return false;
}

/**
 * True when every changed file is documentation (never affects boot/runtime behavior) —
 * markdown/rst/adoc, anything under a `docs/` directory, or a LICENSE/CHANGELOG/NOTICE/
 * AUTHORS/CONTRIBUTING file carrying no extension or a documentation one. An empty file list
 * is NOT docs-only (nothing changed is
 * not the same claim as "only docs changed") — callers should not use this to skip a gate
 * when the diff couldn't be determined.
 */
export function isDocsOnlyDiff(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every(isDocsOnlyFile);
}
