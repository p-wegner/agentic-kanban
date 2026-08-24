// @gate:always-run
//
// #826 — the THIRD half of the openapi gate. `openapi-drift.test.ts` proves the committed spec
// matches what the generator produces; `openapi-route-coverage.test.ts` proves the generator
// looks at every route; this suite proves it can see the statuses the ERROR MIDDLEWARE decides.
//
// The generator derived an operation's `responses` from literal `c.json(body, status)` call
// sites only, so a route that answers 404 by THROWING a domain error documented no 404 at all
// — `GET /api/projects/:id/branches` and `GET /api/sessions/:sessionId/output` both did that
// live. Worse, it made the spec punish the right refactor: converting an inline
// `c.json({ error }, 404)` onto `domainErrorHandler` (which `INLINE_ROUTE_ERROR_CAP` exists to
// encourage, and which #823 made behaviour-preserving) DELETED the documented status, because
// the generator could no longer see it. Measured on `POST /api/workspaces/{id}/review`: −10
// lines, losing its 404 and 400.
//
// It spawns the generator over the whole `packages/server/src` tree, so it reaches state far
// outside its own import graph — hence the marker.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadErrorStatusMaps } from "../../scripts/generate-openapi.js";
import { DOMAIN_CODE_STATUS } from "../middleware/error-handler.js";
import {
  STANDALONE_REFUSAL_STATUS,
  NotFoundError,
  ValidationError,
  UnprocessableError,
  ConflictError,
  ForbiddenError,
  AiOperationError,
} from "../errors/index.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SERVER_ROOT = join(REPO_ROOT, "packages/server");
const GENERATOR = join(SERVER_ROOT, "scripts/generate-openapi.ts");
const SPEC = join(SERVER_ROOT, "openapi.yaml");
const TSX_CLI = join(
  dirname(createRequire(join(SERVER_ROOT, "package.json")).resolve("tsx/package.json")),
  "dist/cli.mjs",
);

function runGenerator(args: string[]): { ok: boolean; output: string } {
  try {
    const out = execFileSync(process.execPath, [TSX_CLI, GENERATOR, ...args], {
      cwd: SERVER_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` || (e.message ?? "") };
  }
}

/**
 * The committed spec, with line endings normalized to LF.
 *
 * The assertions below anchor on `\n  <path>:\n`, which is a claim about the spec's CONTENT
 * — but under a CRLF checkout the terminator is `:\r\n` and every lookup reports the path as
 * ABSENT. That is not hypothetical: `core.autocrlf=true` is set in this repo, so git checks
 * this file out as CRLF into every worktree while the main checkout holds the generator's own
 * LF bytes. The test therefore passed on master and failed in all twelve worktrees — i.e. in
 * every pre-merge gate run, for every branch, blaming whichever branch happened to be in the
 * queue. `.gitattributes` now pins the file to LF so new checkouts agree; this normalization
 * is the belt to that braces, and keeps the assertion about content rather than about
 * whoever's `core.autocrlf` happened to be in force.
 */
function readSpec(): string {
  return readFileSync(SPEC, "utf8").replace(/\r\n/g, "\n");
}

/** The operation block for `<method> <path>` in the committed YAML, as raw text. */
function operationBlock(spec: string, path: string, method: string): string {
  const pathStart = spec.indexOf(`\n  ${path}:\n`);
  expect(pathStart, `path ${path} is absent from the spec`).toBeGreaterThan(-1);
  const pathEnd = spec.indexOf("\n  /", pathStart + 1);
  const pathBlock = spec.slice(pathStart, pathEnd === -1 ? undefined : pathEnd);
  const methodStart = pathBlock.indexOf(`\n    ${method}:\n`);
  expect(methodStart, `${method} ${path} is absent from the spec`).toBeGreaterThan(-1);
  // The next SIBLING method key (4-space indent), not the next 4-space line — the operation's
  // own body is indented deeper, so a naive scan would slice it off after a single line.
  const sibling = /\n {4}[a-z]+:\n/g;
  sibling.lastIndex = methodStart + 1;
  const next = sibling.exec(pathBlock);
  return pathBlock.slice(methodStart, next ? next.index : undefined);
}

describe("openapi thrown-status attribution (#826)", () => {
  it("parses the middleware's OWN status table rather than restating it", () => {
    // The generator must not carry a second copy of the mapping — `errors/index.ts` declares
    // the vocabulary and `middleware/error-handler.ts` maps it, and a third copy in a script
    // nobody reads would be the first to go stale (#587). This is what proves the parse still
    // finds the real table instead of silently returning an empty map, which would delete
    // every derived status from the spec without failing anything.
    const maps = loadErrorStatusMaps();
    expect(maps.domainCodeStatus).toEqual(DOMAIN_CODE_STATUS);
    expect(maps.standaloneStatus).toEqual({ ...STANDALONE_REFUSAL_STATUS });
  });

  it("reads every AppError subclass's status and code off its own super() call", () => {
    const maps = loadErrorStatusMaps();
    // Derived from the classes themselves, not restated: an instance knows its own answer.
    for (const err of [
      new NotFoundError("x"),
      new ValidationError("x"),
      new UnprocessableError("x"),
      new ConflictError("x"),
      new ForbiddenError("x"),
      new AiOperationError("x"),
    ]) {
      expect(maps.appErrorClasses[err.constructor.name], `${err.constructor.name} unparsed`).toEqual({
        status: err.statusCode,
        code: err.code,
      });
    }
  });

  it("documents the 404 of a route that answers it by THROWING", () => {
    const spec = readSpec();
    // The two the ticket measured live. `branches` throws from a SERVICE one hop away,
    // `output` throws in the handler itself — the two shapes the walk has to cover.
    for (const [path, method] of [
      ["/api/projects/{id}/branches", "get"],
      ["/api/sessions/{sessionId}/output", "get"],
    ] as const) {
      const block = operationBlock(spec, path, method);
      expect(block, `${method} ${path} lost its middleware-decided 404`).toContain('"404":');
      expect(block).toContain("thrown NOT_FOUND");
    }
  });

  it("says in the artifact what the attribution CANNOT see", () => {
    // A generator that lists what it found and stays quiet about what it skipped reads as
    // complete — the #824 failure. The bound is written into the spec itself.
    const spec = readSpec();
    expect(spec).toContain("errorResponses:");
    expect(spec).toContain("Attribution stops at");
    expect(spec).toMatch(/cannot be resolved syntactically/);
  });

  it("the generator regenerates that 404 — and the drift gate notices when it is gone", () => {
    // The negative control, in a throwaway copy: proving a gate bites must not require
    // mutating a tracked file in this shared checkout (#814).
    //
    // The assertion that carries the weight is the LINE NUMBER. A bare "the check failed"
    // would pass just as happily if attribution stopped working altogether — the generated
    // spec would then differ from the copy in a hundred other places instead. Pinning the
    // first difference to the line the 404 was removed from says the generator still produces
    // exactly that status there, and nothing before it changed.
    const before = readFileSync(SPEC, "utf8");
    const dir = mkdtempSync(join(tmpdir(), "ak-openapi-thrown-"));
    try {
      const copy = join(dir, "openapi.yaml");
      copyFileSync(SPEC, copy);
      const original = readFileSync(copy, "utf8").replace(/\r\n/g, "\n");
      const block = operationBlock(original, "/api/projects/{id}/branches", "get");
      // Drop the whole `"404":` response entry — everything up to the next key at its indent,
      // or the end of the operation.
      const without = block.replace(/\n( +)"404":(?:\n\1 .*)*(?:\n(?!\1"))?/, "\n");
      expect(without, "the 404 block was not found to remove").not.toBe(block);
      writeFileSync(copy, original.replace(block, without), "utf8");

      // 1-based line the `"404":` key sat on. Everything before it is untouched, so this is
      // exactly where the regenerated spec and the doctored copy must first disagree.
      const marker = /\n( +)"404":/.exec(block)!;
      const removalLine = original.slice(0, original.indexOf(block) + marker.index + 1).split("\n").length;

      const { ok, output } = runGenerator(["--check", "--spec", copy]);
      expect(ok, "the drift gate PASSED with a thrown 404 deleted — attribution is a no-op").toBe(false);
      expect(output).toContain("OUT OF DATE");
      const reported = /first difference at line (\d+):/.exec(output);
      expect(reported, `no first-difference line in:\n${output}`).not.toBeNull();
      expect(
        Number(reported![1]),
        "the first difference is NOT where the 404 was removed — the generator no longer puts "
        + "that middleware-decided status back, or changed something earlier in the spec",
      ).toBe(removalLine);
      // …and what it wants to put there is the 404 (the line is JSON-escaped in the report).
      expect(output).toMatch(/generated: .*404/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(readFileSync(SPEC, "utf8")).toBe(before);
  }, 180_000);
});
