// @gate:always-run — scans services/ for self-HTTP calls; imports nothing it checks (#538).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  parseGuardSource,
  forEachNode,
  lineOf,
  calleeName,
  leadingCommentText,
  compareRatchet,
} from "../../../shared/__tests__/helpers/guard-scan.js";

// Architecture guard for the server CLAUDE.md's #1 documented anti-pattern:
//
//   "A service must never `fetch('http://127.0.0.1:PORT/api/...')` to call its
//    own server. Instead, accept the target service function via dependency
//    injection."
//
// Self-HTTP calls create a hard runtime dependency on port availability, bypass
// the type system (JSON round-trip), are impossible to unit-test without a live
// server, and swallow errors through re-parsing. This was prose-only; the rule is
// now machine-checkable so a regression fails `pnpm test` instead of eroding
// silently. The services layer currently has ZERO such calls — this locks that in.
//
// Scope: the application layer (services/) AND the in-process board monitor cycle
// (startup/monitor-cycle*.ts), which used to fetch its own /api/workspaces routes
// and now drives them through the injected `workspaceActions` port instead. The
// transport adapters (routes/, the dev runner, MCP server) and the CLI legitimately
// speak HTTP, so they are out of scope.
//
// DRAIN BACKLOG: a few `startup/` runners still self-HTTP the create path
// (auto-start, backlog refill, the scheduled-run trigger). They are allow-listed
// below; remove each from STARTUP_SELF_HTTP_ALLOWLIST as it is migrated to a
// direct service call, tightening the gate until the allow-list is empty.
//
// NARROW EXEMPTION: a probe against a plugin's SUPERVISED CHILD PROCESS (its view
// server, spawned by spawnShellCommand on a dynamically allocated port) is not the
// anti-pattern this gate targets — that child is a genuinely separate process with
// no in-process function to inject, not "this server calling itself". Such a probe
// may opt out of the scan with a `SELF-HTTP OK:` comment on the line(s) immediately
// above the call, explaining WHY the target is not this server. This is an explicit,
// per-call, justified opt-out (grep-visible), not a file/directory allow-list.
//
// ## Why this is an AST pass and not a per-line regex (#794, following #779)
//
// The old scan tested one LINE for a call AND an address together, which is the shape
// #779 proved is not evidence. Prettier wraps exactly this call:
//
//     const res = await fetch(
//       `http://127.0.0.1:${port}/api/workspaces`,
//     );
//
// and then the `fetch(` line holds no address and the address line holds no call, so the
// anti-pattern was simply invisible — nobody had to choose the evasion. Worse, the opt-out
// was read from the raw line ABOVE the matched line, which for a wrapped call is the
// `await fetch(` line rather than the comment, so a legitimately exempted probe read as an
// offender the moment it was reflowed.
//
// A `CallExpression` is one node however it is printed, and its arguments are its
// arguments. The opt-out is read with `leadingCommentText`, which walks back from the
// CALL's own line — the thing the convention actually describes.

const SERVICES_DIR = join(import.meta.dirname, "..", "services");
const STARTUP_DIR = join(import.meta.dirname, "..", "startup");

// startup/ files NOT yet migrated off self-HTTP. Each is a known, tracked backlog
// item, not a silent exception — shrink this list as the create path is converted.
const STARTUP_SELF_HTTP_ALLOWLIST = new Set([
  "monitor-auto-start.ts",
  "monitor-backlog.ts",
  "scheduled-tasks.ts",
]);

/** Recursively collect non-test .ts source files under a directory. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** The HTTP clients this guard knows about. */
const HTTP_CALLEES = new Set(["fetch", "axios", "got", "request"]);

/** An argument that names a loopback / own-port address. */
const SELF_ADDRESS =
  /127\.0\.0\.1|localhost|\bgetRuntimePort\b|\bruntimePort\b|\$\{[^}]*[Pp]ort[^}]*\}/;

// Opt-out for a probe against a genuinely separate, board-supervised child process
// (e.g. a plugin's view server) — must carry a reason, not just the bare marker.
const SELF_HTTP_ALLOW_RE = /SELF-HTTP OK:\s*\S.+/;

export interface SelfHttpHit {
  line: number;
  text: string;
}

/**
 * Every self-HTTP call in one source text. Exported so the proof cases below drive the REAL
 * scanner rather than a copy of its predicate.
 */
export function scanSelfHttpSource(cacheKey: string, text: string): SelfHttpHit[] {
  const sf = parseGuardSource(cacheKey, text);
  const hits: SelfHttpHit[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = calleeName(node);
    if (!name || !HTTP_CALLEES.has(name)) return;
    if (!node.arguments.some((argument) => SELF_ADDRESS.test(argument.getText(sf)))) return;
    if (SELF_HTTP_ALLOW_RE.test(leadingCommentText(sf, node))) return;
    hits.push({ line: lineOf(sf, node), text: node.getText(sf).replace(/\s+/g, " ").slice(0, 160) });
  });
  return hits;
}

const relOf = (file: string): string => file.replace(/\\/g, "/").replace(/.*packages\//, "packages/");

/**
 * PRE-EXISTING self-HTTP calls the per-line scan could not see, grandfathered at their
 * current count and shrink-only. #779 warned that an AST conversion surfaces violations the
 * text version was blind to, and that they are to be disclosed rather than fixed under a
 * guard ticket — this is that disclosure.
 *
 * `fleet-mcp-bridge.service.ts` is the whole finding, and HOW it hid is the argument for the
 * conversion in one line: the file registers a catch-all route whose path is the string
 * `"/*"`, and the old `stripComments` pass read that as the start of a block comment. It
 * blanked 93 lines of real code — 326 to 418 — so the guard was scanning an empty string
 * where the `fetch("http://127.0.0.1:...")` was. No wrap, no intent, and the guard reported
 * a clean services layer for as long as that route existed.
 */
const GRANDFATHERED_SELF_HTTP: Record<string, number> = {
  "packages/server/src/services/fleet-mcp-bridge.service.ts": 1,
};

function selfHttpHits(files: string[]): { offenders: string[]; counts: Record<string, number> } {
  const offenders: string[] = [];
  const counts: Record<string, number> = {};
  for (const file of files) {
    const rel = relOf(file);
    for (const hit of scanSelfHttpSource(file, readFileSync(file, "utf8"))) {
      counts[rel] = (counts[rel] ?? 0) + 1;
      if ((counts[rel] ?? 0) <= (GRANDFATHERED_SELF_HTTP[rel] ?? 0)) continue;
      offenders.push(`${rel}:${hit.line}: ${hit.text}`);
    }
  }
  return { offenders, counts };
}

const scanForSelfHttp = (files: string[]): string[] => selfHttpHits(files).offenders;

describe("architecture: no self-HTTP calls in the services layer", () => {
  const files = collectSourceFiles(SERVICES_DIR);

  it("finds service source files to scan", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no service calls its own server over HTTP (use dependency injection instead)", () => {
    const offenders = scanForSelfHttp(files);
    expect(offenders, `Self-HTTP anti-pattern found — inject the target service fn instead:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the grandfathered set only shrinks (#794)", () => {
    const { counts } = selfHttpHits(files);
    const current = Object.fromEntries(
      Object.keys(GRANDFATHERED_SELF_HTTP).map((k) => [k, counts[k] ?? 0]),
    );
    const { stale } = compareRatchet(GRANDFATHERED_SELF_HTTP, current);
    expect(
      stale,
      `Grandfathered self-HTTP call(s) are gone — lower or delete the entry:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});

describe("architecture: the in-process monitor cycle drives workspaces via the port, not self-HTTP", () => {
  const files = collectSourceFiles(STARTUP_DIR).filter(
    (f) => !STARTUP_SELF_HTTP_ALLOWLIST.has(f.split(/[\\/]/).pop() ?? ""),
  );

  it("finds startup source files to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("the monitor cycle (and migrated startup runners) never self-HTTP", () => {
    const offenders = scanForSelfHttp(files);
    expect(
      offenders,
      `Self-HTTP anti-pattern found in startup/ — drive the workspace service through the injected ` +
        `MonitorWorkspaceActions port instead of fetch():\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * #779's proof obligation (#794): the conversion must catch the form the old per-line
 * version could not see, and still catch the ones it did — including the opt-out, which is
 * where the real work of this conversion was.
 */
describe("the self-HTTP scan sees forms the per-line version could not (#794)", () => {
  const scan = (name: string, lines: string[]): SelfHttpHit[] =>
    scanSelfHttpSource(`/virtual/self-http/${name}.ts`, lines.join("\n"));

  it("still catches the one-line self-HTTP call the regex caught", () => {
    expect(scan("one-line", ['const r = await fetch("http://127.0.0.1:3001/api/workspaces");'])).toHaveLength(1);
  });

  it("catches a call WRAPPED so the address is on a different line from the callee", () => {
    // The per-line regex needed the call and the address on ONE line. Prettier wraps exactly
    // this shape, so the anti-pattern became invisible with no intent to hide it.
    const hits = scan("wrapped", [
      "const res = await fetch(",
      "  `http://127.0.0.1:${getRuntimePort()}/api/workspaces`,",
      "  { method: 'POST' },",
      ");",
    ]);
    expect(hits.map((h) => h.line)).toEqual([1]);
  });

  it("still honours a `SELF-HTTP OK:` opt-out written directly above the call", () => {
    expect(
      scan("optout", [
        "// SELF-HTTP OK: a plugin's supervised child view-server, not this board server.",
        "const res = await fetch(`http://127.0.0.1:${port}/health`);",
      ]),
    ).toEqual([]);
  });

  it("honours the opt-out on a WRAPPED call, which the raw-line lookback lost", () => {
    // The old lookback read the line above the MATCHED line — for a wrapped call that is
    // `const res = await fetch(`, not the comment, so a properly exempted probe went red
    // purely because it had been reflowed.
    expect(
      scan("optout-wrapped", [
        "// SELF-HTTP OK: a plugin's supervised child view-server, not this board server.",
        "const res = await fetch(",
        "  `http://127.0.0.1:${port}/health`,",
        ");",
      ]),
    ).toEqual([]);
  });

  it("still refuses a bare marker with no reason", () => {
    expect(scan("bare-marker", ["// SELF-HTTP OK:", 'const r = await fetch("http://localhost:3001/api/x");'])).toHaveLength(
      1,
    );
  });

  it("catches a call the `\"/*\"` route path used to blank out — the live finding", () => {
    // The real defect this conversion surfaced: a catch-all route path is the string `"/*"`,
    // and the old stripComments pass read it as the start of a block comment, deleting every
    // line up to the next `*/`. In the real file that was 93 lines, and the self-HTTP call
    // sat inside them.
    const hits = scan("route-glob", [
      'app.all("/*", async (c) => {',
      '  const r = await fetch(`http://127.0.0.1:${upstream.port}/mcp`);',
      "  return r;",
      "});",
      "/* an ordinary block comment, which is what the text scan thought it had found */",
    ]);
    expect(hits.map((h) => h.line)).toEqual([2]);
  });

  it("does not let a comment inside a string, or prose about the pattern, decide anything", () => {
    const hits = scan("prose", [
      '// Never write fetch("http://127.0.0.1:3001/api/x") — inject the service instead.',
      '/* fetch(`http://localhost:${port}/api/x`) is the shape this guard forbids. */',
      "const doc = 'fetch(\"http://127.0.0.1:3001/api/x\")';",
      "export const noop = () => doc;",
    ]);
    expect(hits).toEqual([]);
  });
});
