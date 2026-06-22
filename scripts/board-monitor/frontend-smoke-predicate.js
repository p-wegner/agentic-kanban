// @ts-check
/**
 * Predicate logic for the frontend smoke check.
 *
 * Extracted here so it can be unit-tested independently of the PowerShell
 * runner (frontend-smoke.ps1) and imported by any other JS/TS helper that
 * needs to know whether a rendered board is considered "ready".
 */

/**
 * Pattern that matches any text that signals a successfully hydrated board.
 *
 * Matches column headers ("Backlog", "Todo", "In Progress"), the empty-column
 * placeholder ("No issues"), and the no-project fallback ("No projects
 * registered").  A match on any of these means the React app has rendered
 * meaningful board content.
 */
const SMOKE_SUCCESS_PATTERN = /Backlog|Todo|In Progress|No issues|No projects registered/;

/**
 * Pattern that matches text indicating Vite compiled successfully but the
 * React app has not yet hydrated.  These are intermediate states that may
 * resolve on the next poll; they are NOT permanent failures.
 *
 * Matches the Vite dev-server "loading" indicator, the React root mounting
 * placeholder, and skeleton / spinner text that appear before hydration.
 */
const EMPTY_RENDER_PATTERN = /^\s*$|^loading[….]*$/i;

/**
 * Normalises arbitrary innerText output (which Playwright may return as a
 * string, an array of strings, or null/undefined) into a single string
 * suitable for pattern matching.
 *
 * @param {unknown} value  Raw value from a Playwright eval call.
 * @returns {string}
 */
function convertToSmokeText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => (item == null ? "" : String(item)))
      .join("\n");
  }
  return String(value);
}

/**
 * Returns up to `maxLength` characters from the normalised smoke text.
 *
 * @param {unknown} value      Raw value from a Playwright eval call.
 * @param {number}  maxLength  Maximum number of characters to return.
 * @returns {string}
 */
function formatSmokeSnippet(value, maxLength = 500) {
  const text = convertToSmokeText(value);
  const length = Math.min(Math.max(maxLength, 0), text.length);
  return text.substring(0, length);
}

/**
 * Returns true when the rendered text looks like a successfully hydrated
 * board shell.
 *
 * This is the single authoritative predicate — both frontend-smoke.ps1 and
 * any future smoke helpers should derive their acceptance logic from this.
 *
 * @param {unknown} renderedText  Raw innerText from a Playwright eval call.
 * @returns {boolean}
 */
function isSmokeSuccess(renderedText) {
  return SMOKE_SUCCESS_PATTERN.test(convertToSmokeText(renderedText));
}

/**
 * Returns true when the rendered text is empty or a loading placeholder,
 * meaning Vite is up and serving the page but React has not yet hydrated.
 *
 * Distinguishes "not hydrated yet (keep polling)" from "wrong content
 * (something else is wrong)".  When this returns true and the server is
 * already responding with HTTP 200, the caller should continue waiting rather
 * than treating this as a definitive failure.
 *
 * @param {unknown} renderedText  Raw innerText from a Playwright eval call.
 * @returns {boolean}
 */
function isEmptyRender(renderedText) {
  return EMPTY_RENDER_PATTERN.test(convertToSmokeText(renderedText));
}

/**
 * Returns a diagnostic label classifying the probe result.
 *
 * - "success"      — board hydrated, probe should stop
 * - "empty-render" — Vite up but React not yet hydrated; keep polling
 * - "wrong-content" — page loaded but content does not match any known state
 *
 * @param {unknown} renderedText  Raw innerText from a Playwright eval call.
 * @returns {"success"|"empty-render"|"wrong-content"}
 */
function classifyProbeResult(renderedText) {
  if (isSmokeSuccess(renderedText)) return "success";
  if (isEmptyRender(renderedText)) return "empty-render";
  return "wrong-content";
}

module.exports = {
  SMOKE_SUCCESS_PATTERN,
  EMPTY_RENDER_PATTERN,
  convertToSmokeText,
  formatSmokeSnippet,
  isSmokeSuccess,
  isEmptyRender,
  classifyProbeResult,
};
