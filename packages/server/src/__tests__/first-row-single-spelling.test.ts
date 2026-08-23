// @gate:always-run
//
// #772 — the `firstRow` ratchet.
//
// `const rows = await …limit(1); return rows[0] ?? null;` was written out by hand ~80 times
// across the repository layer, and the spelling had already drifted three ways
// (`rows.length === 0 ? null : rows[0].id`, `pref.length === 0 ? null : pref[0].value`, and a
// raw one-element array every caller then indexed). #772 collapsed all of them onto the one
// helper `@agentic-kanban/shared/lib/first-row`.
//
// This suite is shrink-only in both directions:
//   - the hand-written spellings are frozen at ZERO and may never come back;
//   - the *other* drift — a repository function that returns the `.limit(1)` builder itself, so
//     its callers index an array — is NOT migrated (that changes 50 function signatures and
//     every caller, which is a bigger job than #772 names). It is grandfathered at its measured
//     count and may only shrink.
//
// It reads the repository tree directly rather than importing it, hence the always-run marker.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORIES_DIR = fileURLToPath(new URL("../repositories", import.meta.url));

function repositoryFiles(dir: string = REPOSITORIES_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...repositoryFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const FILES = repositoryFiles();

function lines(file: string): string[] {
  return readFileSync(file, "utf8").split(/\r?\n/);
}

/** `const rows = await <query>;` immediately followed by `return rows[0] ?? null;`. */
function handWrittenFirstRow(file: string): string[] {
  const src = lines(file);
  const hits: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const decl = /^\s*const (\w+) = await /.exec(src[i]);
    if (!decl) continue;
    let end = i;
    while (end < src.length && !src[end].trimEnd().endsWith(";")) end++;
    const next = src[end + 1];
    if (next?.trim() === `return ${decl[1]}[0] ?? null;`) hits.push(`${file}:${i + 1}`);
  }
  return hits;
}

/** `rows.length === 0 ? null : rows[0]…` — the ternary spelling of the same thing. */
function lengthTernary(file: string): string[] {
  return lines(file)
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /(\w+)\.length === 0 \? null : \1\[0\]/.test(line))
    .map(({ i }) => `${file}:${i + 1}`);
}

/** A repository function that returns the `.limit(1)` builder, leaving the caller to index it. */
function returnsLimitOneArray(file: string): string[] {
  const src = lines(file);
  const hits: string[] = [];
  for (let i = 0; i < src.length; i++) {
    if (!/^\s*return (database|db)\b/.test(src[i])) continue;
    let end = i;
    while (end < src.length && !src[end].trimEnd().endsWith(";")) end++;
    const statement = src.slice(i, end + 1).join(" ");
    if (/\.limit\(1\)\s*(\.offset\([^)]*\))?\s*;/.test(statement)) hits.push(`${file}:${i + 1}`);
  }
  return hits;
}

/**
 * Frozen at the count measured when #772 landed. This one is a CAP, not a zero: migrating these
 * changes the return type of 50 exported repository functions and every call site, which #772
 * deliberately did not attempt. It may only go down.
 */
const LIMIT_ONE_ARRAY_CAP = 50;

describe("firstRow is the single spelling for a limit(1) lookup (#772)", () => {
  it("no repository hand-writes `const rows = await …; return rows[0] ?? null;`", () => {
    const hits = FILES.flatMap(handWrittenFirstRow).map((h) => relative(REPOSITORIES_DIR, h));
    expect(
      hits,
      "Use `firstRow(query)` from @agentic-kanban/shared/lib/first-row instead (#772).",
    ).toEqual([]);
  });

  it("no repository hand-writes the `rows.length === 0 ? null : rows[0]` ternary", () => {
    const hits = FILES.flatMap(lengthTernary).map((h) => relative(REPOSITORIES_DIR, h));
    expect(
      hits,
      "Use `(await firstRow(query))?.field ?? null` instead (#772).",
    ).toEqual([]);
  });

  it("the un-migrated array-returning `.limit(1)` repositories only shrink", () => {
    const hits = FILES.flatMap(returnsLimitOneArray);
    expect(
      hits.length,
      `Returning a one-element array from a repository is the drift #772 froze. ` +
        `Migrate one to firstRow and lower LIMIT_ONE_ARRAY_CAP; never raise it.`,
    ).toBeLessThanOrEqual(LIMIT_ONE_ARRAY_CAP);
  });

  it("firstRow is actually used across the repository layer", () => {
    const users = FILES.filter((f) => /lib\/first-row/.test(readFileSync(f, "utf8")));
    expect(users.length).toBeGreaterThanOrEqual(40);
  });
});
