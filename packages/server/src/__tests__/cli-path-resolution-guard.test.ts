// @gate:always-run — walks the cli/ source tree it guards; imports nothing it checks (#1038).
/**
 * Every path-taking CLI option/argument resolves against the INVOCATION directory (#1038).
 *
 * `pnpm cli --` runs with cwd = `packages/server`, so a relative `--out BACKLOG.md` typed at
 * the repo root wrote `packages/server/BACKLOG.md` while printing `wrote BACKLOG.md`. The
 * failure looks exactly like success, which is what made it expensive: the operator believes
 * the committed backlog was refreshed.
 *
 * The fix is at the ARGUMENT BOUNDARY — `cliPathArg` attached to the declaration — precisely
 * so the next command to take a path does not inherit the bug. That only holds if it is
 * checked, hence this guard. It fails on two shapes:
 *   1. a path-shaped option/argument declared without the coercion, and
 *   2. a path-shaped argument declared INLINE in `.command("import <file>")`, which cannot
 *      carry a parser at all — use `.command("import").argument("<file>", …, cliPathArg)`.
 *
 * An option whose value is a path in some OTHER namespace (a file inside a reviewed diff)
 * belongs in NOT_A_LOCAL_PATH with its reason, not in a coercion.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const CLI_DIR = join(import.meta.dirname, "..", "cli");

/** Words that mean "this value names a place on the filesystem". */
const PATHY_TOKENS = new Set(["file", "files", "path", "paths", "dir", "directory", "out", "root"]);

/**
 * Declarations whose value is deliberately NOT a filesystem path on this machine.
 * Key: `<file-relative-to-cli>::<declaration spec>`.
 */
const NOT_A_LOCAL_PATH = new Map<string, string>([
  [
    "commands/workspace-interaction.ts::--file <filePath>",
    "a path INSIDE the reviewed diff (a repo-relative key for a diff comment), not a path on this machine",
  ],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** The full text of every `.<method>( … )` call, paren-balanced so multi-line declarations survive. */
function callsTo(source: string, method: string): string[] {
  const calls: string[] = [];
  const needle = `.${method}(`;
  for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
    let depth = 0;
    let end = -1;
    for (let j = i + needle.length - 1; j < source.length; j++) {
      if (source[j] === "(") depth++;
      else if (source[j] === ")" && --depth === 0) { end = j; break; }
    }
    if (end === -1) continue; // unbalanced (a paren inside a string) — not a declaration we can read
    calls.push(source.slice(i, end + 1));
  }
  return calls;
}

/** The declaration spec: the call's first string literal, e.g. `-o, --out <file>`. */
function specOf(call: string): string | null {
  const m = /^\.\w+\(\s*"((?:[^"\\]|\\.)*)"/.exec(call);
  return m ? m[1] : null;
}

/** Split flags/placeholders into lowercase words: `--description-file <path>` → file, path. */
function tokensOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

const takesAValue = (spec: string) => /[<[][^\]>]+[\]>]/.test(spec);
const isPathy = (spec: string) => tokensOf(spec).some((t) => PATHY_TOKENS.has(t));
const hasCoercion = (call: string) => /\bcliPathArg\b/.test(call);

describe("CLI path arguments resolve against the invocation directory (#1038)", () => {
  const files = sourceFiles(CLI_DIR);

  it("finds the CLI sources it is meant to guard", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("declares every path-taking option/argument with the cliPathArg coercion", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(CLI_DIR, file).replace(/\\/g, "/");
      const source = readFileSync(file, "utf8");
      for (const method of ["option", "requiredOption", "argument"]) {
        for (const call of callsTo(source, method)) {
          const spec = specOf(call);
          if (!spec || !takesAValue(spec) || !isPathy(spec)) continue;
          if (NOT_A_LOCAL_PATH.has(`${rel}::${spec}`)) continue;
          if (!hasCoercion(call)) offenders.push(`${rel}  .${method}("${spec}")`);
        }
      }
    }

    expect(
      offenders,
      "These take a filesystem path but resolve it against process.cwd() — which is " +
        "packages/server under `pnpm cli --`, so a relative value silently lands in the wrong " +
        "directory (#1038). Add the coercion at the declaration:\n" +
        '  .option("--out <file>", "…", cliPathArg)   // import { cliPathArg } from "../cli-path.js"\n' +
        "If the value is a path in another namespace (e.g. inside a diff), add it to " +
        "NOT_A_LOCAL_PATH with the reason instead.\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("declares no path argument inline in .command(), which cannot carry a parser", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(CLI_DIR, file).replace(/\\/g, "/");
      const source = readFileSync(file, "utf8");
      for (const call of callsTo(source, "command")) {
        const spec = specOf(call);
        if (!spec) continue;
        const inlineArgs = spec.match(/[<[][^\]>]+[\]>]/g) ?? [];
        for (const arg of inlineArgs) {
          if (!isPathy(arg)) continue;
          if (NOT_A_LOCAL_PATH.has(`${rel}::${spec}`)) continue;
          offenders.push(`${rel}  .command("${spec}")`);
        }
      }
    }

    expect(
      offenders,
      "Commander applies no parser to an argument declared inline in .command(), so these " +
        "paths cannot be resolved at the boundary (#1038). Split the declaration:\n" +
        '  .command("import").argument("<file>", "…", cliPathArg)\n  ' +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("catches a declaration that would regress (the guard is not vacuous)", () => {
    const bad = '.option("--out <file>", "Write here")';
    const spec = specOf(bad)!;
    expect(takesAValue(spec) && isPathy(spec) && !hasCoercion(bad)).toBe(true);

    const good = '.option("--out <file>", "Write here", cliPathArg)';
    expect(hasCoercion(good)).toBe(true);

    // ...and does not fire on look-alikes that are not paths.
    expect(isPathy("--profile <claudeProfile>")).toBe(false);
    expect(isPathy("-t, --timeout <seconds>")).toBe(false);
    expect(takesAValue("--keep-base-path")).toBe(false);
  });
});
