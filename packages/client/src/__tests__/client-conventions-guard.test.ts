// @gate:always-run — scans the whole client source tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The client's stated conventions, enforced (#601).
 *
 * `packages/client/CLAUDE.md` states three rules — one transport, one URL writer, one
 * settings reader — and until now all three were convention only. The client is also the
 * package whose guards reach the gate LAST: `test-mine`'s `PACKAGES` and the marker
 * ratchet's roots both had to be widened to include it (#639/#647), and even then the
 * client's two existing guard suites carried no `@gate:always-run`, so "classify by
 * declaration" stopped at the package boundary.
 *
 * Deliberately a TEST rather than only an eslint rule. `pnpm lint` is part of `pnpm check`,
 * but the pre-merge gate's `verify_script` is `test:mine` — so an eslint-only rule does not
 * gate a merge, which is exactly where these conventions need to hold.
 */
const clientSrc = path.join(import.meta.dirname!, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

const files = walk(clientSrc);
const rel = (f: string) => path.relative(clientSrc, f).split(path.sep).join("/");
/**
 * Read each file at most ONCE for the whole suite.
 *
 * Every `it` below walks the same ~500-file list, so an uncached read did the same I/O
 * four times over. Alone that still finished inside vitest's 5s default; under
 * `pnpm test:mine`, where this suite competes with the other workers, it did not — and
 * because `test:mine` doubles as the merge verify_script, the timeout read as a FAILING
 * GATE on diffs that had nothing to do with it. Same failure mode, and same reasoning, as
 * the git suites' `GIT_IO_TIMEOUT_MS` note: the cost is I/O, not the code under test.
 */
const readCache = new Map<string, string>();
const read = (f: string) => {
  let cached = readCache.get(f);
  if (cached === undefined) {
    cached = fs.readFileSync(f, "utf8");
    readCache.set(f, cached);
  }
  return cached;
};

/**
 * Explicit budget for the scanning tests. Belt to the cache's braces: it removes the
 * redundant work, this survives a slow or loaded machine. A hang still never completes,
 * so this only removes the false red.
 */
const SCAN_TIMEOUT_MS = Number(process.env.VITEST_GUARD_SCAN_TIMEOUT) || 60_000;

/**
 * Blank out comment bodies, keeping line count so reported line numbers stay true.
 *
 * Without this the fetch scanner flags six PROSE mentions of "the timeline's own fetch (…)"
 * and none of them is code. A guard that fires on comments about the thing it guards is
 * worse than none: it trains people to stop writing the comments.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1: string) => p1);
}

describe("client conventions (#601)", () => {
  it("the scan reaches the client tree", () => {
    expect(files.length).toBeGreaterThan(200);
  }, SCAN_TIMEOUT_MS);

  /**
   * One transport. A raw `fetch` outside `lib/api.ts` is allowed ONLY with the
   * `eslint-disable-next-line no-restricted-syntax` exemption the eslint rule's own message
   * prescribes — which forces the reason to be written AT the call site rather than in an
   * allow-list in this file, where it would rot out of sight of the code it excuses.
   *
   * The existing rule only covers `components/`; both undocumented bypasses were in
   * `hooks/`, so this scanner covers the whole tree.
   */
  it("raw fetch() outside lib/api.ts carries a documented exemption", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (rel(file) === "lib/api.ts") continue;
      const raw = read(file);
      // Match the CALL on stripped text so prose about "the timeline's own fetch (…)" is not
      // a hit — but read the EXEMPTION from the raw text, because stripping removes the very
      // comment that grants it. Two views of one file, each answering the half it can.
      const code = stripComments(raw).split(/\r?\n/);
      const original = raw.split(/\r?\n/);
      code.forEach((line, i) => {
        if (!/(^|[^\w.])fetch\s*\(/.test(line)) return;
        // The exemption may sit on either of the two preceding lines (a wrapped comment).
        const preceding = `${original[i - 1] ?? ""}\n${original[i - 2] ?? ""}`;
        if (preceding.includes("no-restricted-syntax")) return;
        offenders.push(`${rel(file)}:${i + 1}`);
      });
    }
    expect(
      offenders,
      "use apiFetch/apiPost/… from lib/api.ts, or add an `eslint-disable-next-line " +
        "no-restricted-syntax -- <reason>` above the call:\n" + offenders.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  /**
   * One URL writer (#446). Components change STATE; `routes/` decides the path and whether
   * it is a push or a replace. A component writing `history.pushState` is how the two
   * disagree about what one logical navigation means.
   */
  it("only routes/ writes the URL", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const r = rel(file);
      if (r.startsWith("routes/")) continue;
      const lines = stripComments(read(file)).split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/history\.(pushState|replaceState)|location\.pathname\s*=[^=]/.test(line)) {
          offenders.push(`${r}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      "change state and let routes/boardRouteSync.ts decide the path (see client/CLAUDE.md " +
        "“URL scheme”):\n" + offenders.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  /**
   * One settings reader. `settingsStore` owns `/api/preferences` — a raw hit bypasses
   * `invalidateSettings()`, so the store and the server disagree until something else
   * refetches. 15 files still do it; frozen and shrink-only rather than allow-listed,
   * because a 15-entry list is a count wearing a disguise.
   */
  const PREFERENCES_BYPASS_BASELINE = 15;
  const preferenceBypasses = () =>
    files.filter((f) => !rel(f).includes("settingsStore") && read(f).includes("/api/preferences")).map(rel);

  it("the raw /api/preferences count only ever shrinks", () => {
    const hits = preferenceBypasses();
    expect(
      hits.length,
      "read/write settings through lib/settingsStore (it calls invalidateSettings):\n" + hits.join("\n"),
    ).toBeLessThanOrEqual(PREFERENCES_BYPASS_BASELINE);
  }, SCAN_TIMEOUT_MS);

  it("the baseline is not stale — lower it when the count drops", () => {
    expect(preferenceBypasses().length).toBe(PREFERENCES_BYPASS_BASELINE);
  }, SCAN_TIMEOUT_MS);
});
