import { describe, it, expect } from "vitest";
import type { ProjectRepoResponse } from "@agentic-kanban/shared";
import { buildRepoPatch, repoFormFromResponse, type RepoEditFormState } from "./repoEditPayload.js";

const base: RepoEditFormState = { name: "web", setupScript: "pnpm install", composeFile: "docker-compose.yml" };

describe("buildRepoPatch", () => {
  it("returns an empty patch when nothing changed", () => {
    expect(buildRepoPatch(base, { ...base })).toEqual({});
  });

  it("sends only the changed name (trimmed)", () => {
    expect(buildRepoPatch(base, { ...base, name: "  api  " })).toEqual({ name: "api" });
  });

  it("does not send name when only surrounding whitespace differs", () => {
    expect(buildRepoPatch(base, { ...base, name: "  web  " })).toEqual({});
  });

  it("sends setupScript alone when only it changed", () => {
    expect(buildRepoPatch(base, { ...base, setupScript: "cargo fetch" })).toEqual({
      setupScript: "cargo fetch",
    });
  });

  it("sends null when a nullable field is cleared to blank", () => {
    expect(buildRepoPatch(base, { ...base, composeFile: "   " })).toEqual({ composeFile: null });
  });

  it("does not clobber unchanged fields when several change together", () => {
    const patch = buildRepoPatch(base, { name: "api", setupScript: "uv sync", composeFile: "docker-compose.yml" });
    expect(patch).toEqual({ name: "api", setupScript: "uv sync" });
    expect(patch).not.toHaveProperty("composeFile");
  });

  it("treats a from-null field left blank as unchanged (no key emitted)", () => {
    const start: RepoEditFormState = { name: "web", setupScript: "", composeFile: "" };
    expect(buildRepoPatch(start, { ...start, name: "web" })).toEqual({});
  });
});

describe("repoFormFromResponse", () => {
  it("maps null fields to empty strings", () => {
    const repo = {
      id: "r1",
      projectId: "p1",
      path: "/x",
      name: null,
      defaultBranch: null,
      setupScript: null,
      composeFile: null,
      createdAt: "2026-01-01",
    } satisfies ProjectRepoResponse;
    expect(repoFormFromResponse(repo)).toEqual({ name: "", setupScript: "", composeFile: "" });
  });

  it("carries through populated fields", () => {
    const repo = {
      id: "r1",
      projectId: "p1",
      path: "/x",
      name: "web",
      defaultBranch: "main",
      setupScript: "pnpm install",
      composeFile: "docker-compose.yml",
      createdAt: "2026-01-01",
    } satisfies ProjectRepoResponse;
    expect(repoFormFromResponse(repo)).toEqual({
      name: "web",
      setupScript: "pnpm install",
      composeFile: "docker-compose.yml",
    });
  });
});
