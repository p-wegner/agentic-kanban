import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LAST_ACTIVE_PROJECT_STORAGE_KEY,
  readLastActiveProjectId,
  resolveNextActiveProjectId,
} from "./useBoardDataController.js";

const projects = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("resolveNextActiveProjectId — cold-load seed reconciliation", () => {
  it("returns null when there are no projects", () => {
    expect(
      resolveNextActiveProjectId({ current: "a", currentIsSeeded: true, projects: [], preferredId: "a" }),
    ).toBeNull();
  });

  it("keeps a seeded id when the server preference agrees (the common case — no visible change)", () => {
    expect(
      resolveNextActiveProjectId({ current: "b", currentIsSeeded: true, projects, preferredId: "b" }),
    ).toBe("b");
  });

  it("the server preference overrides a differing seeded id (reconcile)", () => {
    expect(
      resolveNextActiveProjectId({ current: "b", currentIsSeeded: true, projects, preferredId: "c" }),
    ).toBe("c");
  });

  it("a stale seeded id (project gone) falls back to the preference / first project", () => {
    expect(
      resolveNextActiveProjectId({ current: "zombie", currentIsSeeded: true, projects, preferredId: null }),
    ).toBe("a");
  });

  it("a non-seeded current selection is sticky (pre-existing #327 behavior)", () => {
    expect(
      resolveNextActiveProjectId({ current: "b", currentIsSeeded: false, projects, preferredId: "c" }),
    ).toBe("b");
  });

  it("with no current selection, prefers the server preference then the first project", () => {
    expect(
      resolveNextActiveProjectId({ current: null, currentIsSeeded: false, projects, preferredId: "c" }),
    ).toBe("c");
    expect(
      resolveNextActiveProjectId({ current: null, currentIsSeeded: false, projects, preferredId: "gone" }),
    ).toBe("a");
  });
});

describe("readLastActiveProjectId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when localStorage is unavailable (node test environment)", () => {
    expect(readLastActiveProjectId()).toBeNull();
  });

  it("reads the stored id from localStorage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    localStorage.setItem(LAST_ACTIVE_PROJECT_STORAGE_KEY, "proj-42");
    expect(readLastActiveProjectId()).toBe("proj-42");
  });
});
