import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

/** Strip // line and block comments so a comment mentioning localhost is not flagged. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// A fetch/axios/got/request call whose argument references a loopback / own-port
// address. Tolerates whitespace and a leading `globalThis.`/`await`.
const SELF_HTTP_RE =
  /\b(?:fetch|axios|got|request)\s*\(\s*[^)]*?(?:127\.0\.0\.1|localhost|\bgetRuntimePort\b|\bruntimePort\b|\$\{[^}]*[Pp]ort[^}]*\})/;

function scanForSelfHttp(files: string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const line of code.split("\n")) {
      if (SELF_HTTP_RE.test(line)) {
        offenders.push(`${file.replace(/\\/g, "/").replace(/.*packages\//, "packages/")}: ${line.trim()}`);
      }
    }
  }
  return offenders;
}

describe("architecture: no self-HTTP calls in the services layer", () => {
  const files = collectSourceFiles(SERVICES_DIR);

  it("finds service source files to scan", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no service calls its own server over HTTP (use dependency injection instead)", () => {
    const offenders = scanForSelfHttp(files);
    expect(offenders, `Self-HTTP anti-pattern found — inject the target service fn instead:\n${offenders.join("\n")}`).toEqual([]);
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
