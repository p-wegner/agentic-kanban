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

/**
 * What a file living under a `docs/` directory may be and still count as documentation (#642).
 *
 * The directory rule used to be `/(^|\/)docs\//i` with NO extension test at all — a `docs/`
 * segment ANYWHERE in the path, any extension. So `packages/server/src/docs/anything.ts`,
 * `scripts/docs/build.mjs` or a `docs/tools/*.js` diff skipped the ENTIRE gate (since #198
 * widened docs-only to skip verify AND smoke): no build, no tests, no boot check.
 *
 * This is the third instance of one shape. The module's own header records the other two —
 * the `.txt` rule (`requirements.txt` is a dependency manifest) and the `\.[a-z0-9]+`
 * wildcard (#240, `services/changelog.ts` read as documentation). Each time the fix was to
 * CLOSE the set, so the directory rule gets the same treatment rather than a fourth comment
 * about it.
 *
 * Deliberately excluded even under `docs/`: every executable extension, and `.json`/`.yaml` —
 * this repo ships live artifacts at `docs/verification/*.json` and `docs/domain/_plan.json`
 * that code reads. Extensionless files under `docs/` are admitted (a bare `docs/NOTES`).
 */
const DOCS_DIR_EXTENSIONS = /\.(md|mdx|rst|adoc|txt|png|jpe?g|gif|svg|webp|ico|pdf|drawio|puml|mmd|csv)$/i;

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
  // #642: a `docs/` segment is not by itself evidence of documentation — the FILE has to be
  // documentation too. See DOCS_DIR_EXTENSIONS.
  if (/(^|\/)docs\//i.test(normalized)) {
    return !base.includes(".") || DOCS_DIR_EXTENSIONS.test(base);
  }
  return false;
}

/**
 * True when every changed file is documentation (never affects boot/runtime behavior) —
 * markdown/rst/adoc, a documentation FILE under a `docs/` directory (#642 — not merely
 * anything living there), or a LICENSE/CHANGELOG/NOTICE/
 * AUTHORS/CONTRIBUTING file carrying no extension or a documentation one. An empty file list
 * is NOT docs-only (nothing changed is
 * not the same claim as "only docs changed") — callers should not use this to skip a gate
 * when the diff couldn't be determined.
 */
export function isDocsOnlyDiff(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every(isDocsOnlyFile);
}

/**
 * Paths that are NOT documentation but that no test can import either (#1008): board/agent
 * configuration and generated data. A diff made only of these (plus documentation) cannot
 * change what the package suites observe, but it is exactly what the `@gate:always-run`
 * GUARD suites exist to check — the hook-wiring parity guards read `.claude/settings*.json`
 * and `.codex/**`, the ratchets read `.gitignore`. So such a diff routes to the guard suites
 * (+ typecheck), never to the FULL suite the null package scope used to imply.
 *
 * Deliberately CLOSED, like every other set in this module (#240, #642): a path the gate
 * cannot reason about must keep running everything. Observed on #999: `.claude/settings.json`,
 * `.code-metrics/agent-vocabulary.json`, `.gitignore` and a `docs/analysis/*.md` ran the whole
 * server package twice and timed out the 90-minute budget both times.
 */
const GUARDS_ONLY_PATHS: RegExp[] = [
  /(^|\/)\.gitignore$/i,
  /(^|\/)\.code-metrics\//i,
  /(^|\/)\.claude\/settings[^/]*\.json$/i,
  /(^|\/)\.codex\//i,
];

/**
 * Under `docs/`, #642's closed extension set decides what is DOCUMENTATION; this decides what
 * is merely NOT CODE. A `docs/verification/*.json` artifact is read by tests, so it is not
 * docs-only — but no package suite imports it, so the guard suites are still the right run.
 * Executable extensions stay OUT: a `docs/tools/*.js` is code wherever it lives.
 */
const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|rb|sh|ps1|bat|cmd|kt|kts|java|go|rs|sql|yml|yaml)$/i;

function isGuardsOnlyFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (isDocsOnlyFile(normalized)) return true;
  if (GUARDS_ONLY_PATHS.some((re) => re.test(normalized))) return true;
  if (/^docs\//i.test(normalized)) return !CODE_EXTENSIONS.test(normalized);
  return false;
}

/**
 * True when every changed file is documentation OR one of the modelled config/data paths above
 * (#1008) — a superset of {@link isDocsOnlyDiff}. Such a diff can be verified by the
 * `@gate:always-run` guard suites plus typecheck instead of the full suite. An empty list is
 * NOT guards-only, for the same reason it is not docs-only.
 */
export function isGuardsOnlyDiff(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every(isGuardsOnlyFile);
}
