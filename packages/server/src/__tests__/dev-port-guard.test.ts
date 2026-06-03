/**
 * Regression test for the bug where freePort(serverPort) killed the Vite client
 * because netstat returned PIDs for established connections TO the port, not just
 * listeners. parseNetstatListeners must only return LISTENING rows.
 */
import { describe, expect, it } from "vitest";
// @ts-ignore — scripts/ is .mjs, not in tsconfig
import { parseNetstatListeners, commandLineBelongsToCheckout } from "../../../../scripts/dev-port-guard.mjs";

const NETSTAT_SAMPLE = `
  Proto  Local Address           Foreign Address         State           PID
  TCP    0.0.0.0:135             0.0.0.0:0               LISTENING       1234
  TCP    127.0.0.1:3001          0.0.0.0:0               LISTENING       5001
  TCP    127.0.0.1:5173          0.0.0.0:0               LISTENING       5002
  TCP    127.0.0.1:55234         127.0.0.1:3001          ESTABLISHED     5002
  TCP    127.0.0.1:55235         127.0.0.1:3001          ESTABLISHED     5003
  TCP    127.0.0.1:3001          127.0.0.1:55234         ESTABLISHED     5001
  UDP    0.0.0.0:500             *:*                                     9876
`;

describe("parseNetstatListeners", () => {
  it("returns only the PID that is LISTENING on the given port", () => {
    const pids = parseNetstatListeners(NETSTAT_SAMPLE, 3001);
    expect(pids).toEqual(["5001"]);
  });

  it("does not return PIDs of processes with established connections TO the port", () => {
    // Vite (5002) has an ESTABLISHED connection to :3001 (proxy). Must not be killed.
    // Another client process (5003) also connects to :3001. Must not be killed.
    const pids = parseNetstatListeners(NETSTAT_SAMPLE, 3001);
    expect(pids).not.toContain("5002");
    expect(pids).not.toContain("5003");
  });

  it("returns empty array when nothing listens on the port", () => {
    const pids = parseNetstatListeners(NETSTAT_SAMPLE, 9999);
    expect(pids).toEqual([]);
  });

  it("returns the Vite listener PID when querying the Vite client port", () => {
    const pids = parseNetstatListeners(NETSTAT_SAMPLE, 5173);
    expect(pids).toEqual(["5002"]);
  });

  it("deduplicates multiple matching rows for the same PID", () => {
    const duplicated = `
  TCP    127.0.0.1:3001          0.0.0.0:0               LISTENING       5001
  TCP    0.0.0.0:3001            0.0.0.0:0               LISTENING       5001
    `;
    const pids = parseNetstatListeners(duplicated, 3001);
    expect(pids).toEqual(["5001"]);
  });
});

describe("commandLineBelongsToCheckout", () => {
  it("returns true when the command line references the checkout root", () => {
    expect(commandLineBelongsToCheckout(
      "node C:/andrena/agentic-kanban/packages/client/node_modules/vite/bin/vite.js",
      "C:/andrena/agentic-kanban"
    )).toBe(true);
  });

  it("returns false for a process from a different checkout", () => {
    expect(commandLineBelongsToCheckout(
      "node C:/other-project/packages/client/node_modules/vite/bin/vite.js",
      "C:/andrena/agentic-kanban"
    )).toBe(false);
  });

  it("returns false for a worktree process when checking root is a different worktree", () => {
    expect(commandLineBelongsToCheckout(
      "node C:/andrena/.worktrees/feature_200-foo/scripts/dev.mjs",
      "C:/andrena/.worktrees/feature_355-other"
    )).toBe(false);
  });
});
