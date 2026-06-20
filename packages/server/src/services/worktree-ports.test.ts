import { describe, it, expect } from "vitest";
import {
  BASE_SERVER_PORT,
  BASE_CLIENT_PORT,
  branchHash,
  portOffsetFromName,
  portsForOffset,
  derivePortsFromBranch,
  resolveWorktreeDevPorts,
} from "./worktree-ports.js";

describe("branchHash", () => {
  it("is deterministic and within the 101-1000 range (above issue-number space)", () => {
    for (const name of ["feature/foo", "bugfix/bar", "weird_branch", "x"]) {
      const h = branchHash(name);
      expect(h).toBe(branchHash(name));
      expect(h).toBeGreaterThanOrEqual(101);
      expect(h).toBeLessThanOrEqual(1000);
    }
  });
});

describe("portOffsetFromName", () => {
  it("uses the issue number for an ak-<N> branch", () => {
    expect(portOffsetFromName("feature/ak-99-launch-preview")).toBe(99);
    expect(portOffsetFromName("ak-7-foo")).toBe(7);
  });

  it("uses the issue number for a feature/<N> branch", () => {
    expect(portOffsetFromName("feature/42-thing")).toBe(42);
    expect(portOffsetFromName("feature_42-thing")).toBe(42);
  });

  it("falls back to the stable hash when no issue number is encoded", () => {
    expect(portOffsetFromName("main")).toBe(branchHash("main"));
    expect(portOffsetFromName("feature/no-number")).toBe(branchHash("feature/no-number"));
  });
});

describe("portsForOffset", () => {
  it("adds the offset to each base port", () => {
    expect(portsForOffset(5)).toEqual({ serverPort: BASE_SERVER_PORT + 5, clientPort: BASE_CLIENT_PORT + 5 });
  });
});

describe("derivePortsFromBranch", () => {
  it("derives issue-numbered ports for an ak branch", () => {
    expect(derivePortsFromBranch("feature/ak-99-launch-preview")).toEqual({
      serverPort: BASE_SERVER_PORT + 99,
      clientPort: BASE_CLIENT_PORT + 99,
    });
  });

  it("derives hash-offset ports for a non-numbered branch", () => {
    const offset = branchHash("scratch");
    expect(derivePortsFromBranch("scratch")).toEqual({
      serverPort: BASE_SERVER_PORT + offset,
      clientPort: BASE_CLIENT_PORT + offset,
    });
  });
});

describe("resolveWorktreeDevPorts", () => {
  it("returns null for a non-worktree path", () => {
    expect(resolveWorktreeDevPorts("C:/andrena/agentic-kanban")).toBeNull();
    expect(resolveWorktreeDevPorts("/home/me/project")).toBeNull();
  });

  it("derives ports from the worktree leaf (issue-numbered)", () => {
    expect(resolveWorktreeDevPorts("C:/repo/.worktrees/feature-ak-12-foo")).toEqual({
      serverPort: BASE_SERVER_PORT + 12,
      clientPort: BASE_CLIENT_PORT + 12,
    });
  });

  it("normalizes backslashes and handles a hashed leaf", () => {
    const offset = branchHash("scratchpad");
    expect(resolveWorktreeDevPorts("C:\\repo\\.worktrees\\scratchpad")).toEqual({
      serverPort: BASE_SERVER_PORT + offset,
      clientPort: BASE_CLIENT_PORT + offset,
    });
  });
});
