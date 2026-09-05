import { describe, it, expect, afterEach, vi } from "vitest";
import { resolve, sep } from "node:path";
import { invocationCwd, resolveCliPath, cliPathArg } from "../cli-path.js";

/**
 * #1038 — `pnpm cli -- backlog export --out BACKLOG.md` from the repo root wrote
 * `packages/server/BACKLOG.md` and printed `wrote BACKLOG.md`: a miss that looks like a
 * success. These pin the resolution helper with INIT_CWD set and unset, which is the
 * difference between the two directories.
 */

const ROOT = resolve(sep, "projects", "board");
const PKG = resolve(ROOT, "packages", "server");

const ORIGINAL_INIT_CWD = process.env.INIT_CWD;

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_INIT_CWD === undefined) delete process.env.INIT_CWD;
  else process.env.INIT_CWD = ORIGINAL_INIT_CWD;
});

function cwdIs(dir: string) {
  vi.spyOn(process, "cwd").mockReturnValue(dir);
}

describe("invocationCwd (#1038)", () => {
  it("prefers INIT_CWD — the directory the operator actually typed the command in", () => {
    cwdIs(PKG);
    expect(invocationCwd({ INIT_CWD: ROOT })).toBe(ROOT);
  });

  it("falls back to process.cwd() when INIT_CWD is unset", () => {
    cwdIs(PKG);
    expect(invocationCwd({})).toBe(PKG);
  });

  it("ignores an empty or relative INIT_CWD rather than resolving against it", () => {
    cwdIs(PKG);
    expect(invocationCwd({ INIT_CWD: "" })).toBe(PKG);
    expect(invocationCwd({ INIT_CWD: "some/relative/dir" })).toBe(PKG);
  });
});

describe("resolveCliPath (#1038)", () => {
  it("resolves a relative path against INIT_CWD, not the package cwd", () => {
    cwdIs(PKG);
    expect(resolveCliPath("BACKLOG.md", { INIT_CWD: ROOT })).toBe(resolve(ROOT, "BACKLOG.md"));
  });

  it("resolves against the cwd when INIT_CWD is unset", () => {
    cwdIs(PKG);
    expect(resolveCliPath("BACKLOG.md", {})).toBe(resolve(PKG, "BACKLOG.md"));
  });

  it("leaves an absolute path alone", () => {
    cwdIs(PKG);
    const abs = resolve(ROOT, "docs", "BACKLOG.md");
    expect(resolveCliPath(abs, { INIT_CWD: ROOT })).toBe(abs);
  });

  it("handles the dot and parent forms", () => {
    cwdIs(PKG);
    expect(resolveCliPath(".", { INIT_CWD: ROOT })).toBe(ROOT);
    expect(resolveCliPath("./out/BACKLOG.md", { INIT_CWD: ROOT })).toBe(resolve(ROOT, "out", "BACKLOG.md"));
    expect(resolveCliPath("../BACKLOG.md", { INIT_CWD: PKG })).toBe(resolve(PKG, "..", "BACKLOG.md"));
  });

  it("always returns an absolute path, so a success message can name it", () => {
    cwdIs(PKG);
    expect(resolveCliPath("BACKLOG.md", { INIT_CWD: ROOT }).startsWith(ROOT)).toBe(true);
  });
});

describe("cliPathArg (the commander coercion)", () => {
  it("resolves against the live INIT_CWD", () => {
    cwdIs(PKG);
    process.env.INIT_CWD = ROOT;
    expect(cliPathArg("BACKLOG.md")).toBe(resolve(ROOT, "BACKLOG.md"));
  });

  it("ignores commander's second `previous` argument", () => {
    // Commander calls a parser as fn(value, previous). resolveCliPath's second parameter is
    // an ENV, so passing it straight to commander would hand `previous` in as one.
    cwdIs(PKG);
    delete process.env.INIT_CWD;
    const asCommanderCalls = cliPathArg as unknown as (v: string, previous?: unknown) => string;
    expect(asCommanderCalls("BACKLOG.md", { INIT_CWD: ROOT })).toBe(resolve(PKG, "BACKLOG.md"));
  });
});
