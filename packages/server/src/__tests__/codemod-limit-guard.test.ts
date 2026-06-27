// @covers codemods.preview.limit-guard [boundary, config, error-handling]
//
// The codemod preview is a blast-radius operation: it dry-runs a transform over
// EVERY TS file in the project. To stop the operator from accidentally running
// a repo-wide rewrite, previewCodemod() refuses when a project has MORE than
// CODEMOD_FILE_LIMIT (100) collectable TS files, unless the caller explicitly
// acknowledges the scale via { overrideLimit: true }. This is the module's
// scale safety interlock (codemod.service.ts:244) and had ZERO coverage at
// either the block edge or the override-and-proceed edge.
//
// This test drives previewCodemod() directly at the service level (mirroring
// codemod-preview-generate.test.ts). It exercises both the documented config
// constant (CODEMOD_FILE_LIMIT) and the exact threshold semantics:
//   - exactly CODEMOD_FILE_LIMIT files  -> proceeds, no override needed (boundary)
//   - CODEMOD_FILE_LIMIT + 1 files      -> BLOCKED with ValidationError    (boundary/error-handling)
//   - CODEMOD_FILE_LIMIT + 1 + override -> proceeds, limitReached === true (override edge)
//
// The guard uses a strict `>` comparison, so "exactly at the limit" must NOT be
// blocked while "one over" MUST be. Both edges are asserted.
//
// The file-enumeration step (collectTsFiles) reads the real filesystem and
// ts-morph subsequently parses each path off disk, so a mocked enumeration that
// returns non-existent paths would break ts-morph. Instead we materialize real
// (but trivial) .ts files in a temp dir — the cheapest robust way to cross the
// threshold. A no-op transform keeps parsing fast and the diff empty, so the
// assertions are purely about the guard, not the transform.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  previewCodemod,
  CODEMOD_FILE_LIMIT,
} from "../services/codemod.service.js";
import { ValidationError } from "../errors/index.js";

// A transform that changes nothing — we only care about the count guard here,
// not about producing a diff.
const NOOP_TRANSFORM = "/* intentionally does nothing */";

async function makeRepoWithTsFiles(prefix: string, count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  for (let i = 0; i < count; i++) {
    await writeFile(join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`, "utf8");
  }
  return dir;
}

describe("codemods.preview.limit-guard — blast-radius interlock blocks >limit previews unless overridden", () => {
  // The documented limit is a single config constant; everything below is keyed
  // off it so the test tracks the real threshold rather than a hardcoded 100.
  let atLimitRepo: string; // exactly CODEMOD_FILE_LIMIT files
  let overLimitRepo: string; // CODEMOD_FILE_LIMIT + 1 files

  beforeAll(async () => {
    [atLimitRepo, overLimitRepo] = await Promise.all([
      makeRepoWithTsFiles("codemod-limit-at-", CODEMOD_FILE_LIMIT),
      makeRepoWithTsFiles("codemod-limit-over-", CODEMOD_FILE_LIMIT + 1),
    ]);
  });

  afterAll(async () => {
    await Promise.all(
      [atLimitRepo, overLimitRepo].map((d) =>
        d ? rm(d, { recursive: true, force: true }).catch(() => {}) : undefined,
      ),
    );
  });

  // config: the limit is the documented constant, not an inline literal.
  it("exposes the documented file-count limit as CODEMOD_FILE_LIMIT", () => {
    expect(CODEMOD_FILE_LIMIT).toBe(100);
  });

  // boundary (lower edge): exactly at the limit is allowed, no override needed.
  // The guard uses a strict `>` so equality must pass through.
  it("allows a preview at EXACTLY the limit without an override", async () => {
    const result = await previewCodemod(NOOP_TRANSFORM, atLimitRepo);

    expect(result.totalTsFiles).toBe(CODEMOD_FILE_LIMIT);
    expect(result.limitReached).toBe(false);
    // No-op transform changes nothing, so no files are reported.
    expect(result.files).toEqual([]);
  });

  // boundary (over edge) + error-handling: one file over the limit, no override,
  // must throw the documented ValidationError instructing the caller to resend
  // with overrideLimit: true. This is the BLOCK edge.
  it("BLOCKS a preview one file over the limit when no override is given", async () => {
    await expect(previewCodemod(NOOP_TRANSFORM, overLimitRepo)).rejects.toThrow(
      ValidationError,
    );
    // The error message must name the over-limit count and the override path,
    // so the operator knows how to proceed deliberately.
    await expect(
      previewCodemod(NOOP_TRANSFORM, overLimitRepo),
    ).rejects.toThrow(/overrideLimit/i);
    await expect(
      previewCodemod(NOOP_TRANSFORM, overLimitRepo),
    ).rejects.toThrow(new RegExp(String(CODEMOD_FILE_LIMIT + 1)));
  });

  // override edge: the SAME over-limit project proceeds when the caller
  // explicitly acknowledges the blast radius, and the result flags limitReached.
  it("PROCEEDS on the same over-limit project when overrideLimit is true", async () => {
    const result = await previewCodemod(NOOP_TRANSFORM, overLimitRepo, {
      overrideLimit: true,
    });

    expect(result.totalTsFiles).toBe(CODEMOD_FILE_LIMIT + 1);
    expect(result.limitReached).toBe(true);
    expect(result.files).toEqual([]);
  });
});
