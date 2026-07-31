// The connect runbook (`worker instructions`, the `fleet-worker` builtin skill
// and the README) is only useful if it stays true to the actual CLI/prefs. This
// binds it to the implementation so a rename breaks the test, not a user's setup.

import { describe, it, expect } from "vitest";
import { buildWorkerConnectSteps, renderWorkerConnectMarkdown } from "../cli/commands/worker.js";
import { BUILTIN_SKILLS } from "../builtin-skills.js";
import {
  workerDispatchPrefKey,
  workerLabelsPrefKey,
  workerStrictPrefKey,
  SHARES_FILESYSTEM_LABEL,
} from "../services/worker-fleet.service.js";
import { PAIRING_TOKEN_TTL_MS, WORKER_HEARTBEAT_STALE_MS } from "../services/worker-registry.service.js";
import { resolveConfiguredGitPort } from "../services/git-http.service.js";

const BOARD = "http://board.example:3001";
const steps = buildWorkerConnectSteps(BOARD, "TOKEN123");
const markdown = renderWorkerConnectMarkdown(BOARD, "TOKEN123", steps);
const allCommands = steps.flatMap((s) => s.commands).join("\n");

describe("worker connect instructions", () => {
  it("embeds the caller's board URL everywhere a URL is needed", () => {
    expect(markdown).toContain(BOARD);
    expect(allCommands).toContain(`--board ${BOARD}`);
    expect(allCommands).not.toContain("<board-url>");
  });

  it("embeds a supplied pairing token and keeps a placeholder otherwise", () => {
    expect(allCommands).toContain("--token TOKEN123");
    const placeholder = buildWorkerConnectSteps(BOARD, "<pairing-token>");
    expect(placeholder.flatMap((s) => s.commands).join("\n")).toContain("--token <pairing-token>");
  });

  it("uses only flags the worker CLI actually defines", () => {
    const supported = new Set([
      "--board", "--token", "--name", "--labels", "--providers",
      "--max-concurrency", "--state-file", "--work-root", "--shares-filesystem",
      "--leave-agents", "--json",
    ]);
    // Scope to `agentic-kanban worker …` lines: the runbook also shows unrelated
    // commands (`git --version`, a provider CLI check) whose flags are not ours.
    const workerLines = markdown
      .split("\n")
      .filter((line) => line.includes("agentic-kanban worker") || line.trim().startsWith("--"));
    const used = workerLines.join("\n").match(/--[a-z][a-z-]*/g) ?? [];
    expect(used.length).toBeGreaterThan(4);
    const unknown = [...new Set(used)].filter((flag) => !supported.has(flag));
    expect(unknown).toEqual([]);
  });

  it("marks which machine each step runs on", () => {
    const pair = steps.find((s) => s.commands.some((c) => c.includes("worker pair")));
    expect(pair?.where).toBe("board");
    const start = steps.find((s) => s.commands.some((c) => c.includes("worker start")));
    expect(start?.where).toBe("worker");
    expect(markdown).toContain("run on the BOARD machine");
  });

  it("names the real per-project preference keys", () => {
    for (const key of [workerDispatchPrefKey("<projectId>"), workerLabelsPrefKey("<projectId>"), workerStrictPrefKey("<projectId>")]) {
      expect(allCommands).toContain(key);
    }
  });

  it("documents the networking a cross-machine fleet actually needs", () => {
    expect(markdown).toContain("KANBAN_HOST=0.0.0.0");
    // The git port must be pinnable or a firewall rule is impossible.
    expect(markdown).toContain("KANBAN_GIT_HTTP_PORT");
    expect(resolveConfiguredGitPort({ KANBAN_GIT_HTTP_PORT: "3002" })).toBe(3002);
    expect(resolveConfiguredGitPort({})).toBe(0);
    expect(resolveConfiguredGitPort({ KANBAN_GIT_HTTP_PORT: "not-a-port" })).toBe(0);
  });

  it("mentions the same-machine escape hatch by its real flag", () => {
    expect(markdown).toContain("--shares-filesystem");
    expect(SHARES_FILESYSTEM_LABEL).toBe("shares-filesystem");
  });
});

describe("fleet-worker builtin skill", () => {
  const skill = BUILTIN_SKILLS.find((s) => s.name === "fleet-worker");

  it("is shipped so `install-skill` can write it", () => {
    expect(skill).toBeDefined();
    expect(skill!.description).toMatch(/worker/i);
  });

  it("points agents at the CLI runbook instead of hardcoding a command list", () => {
    expect(skill!.prompt).toContain("worker instructions --board");
    expect(skill!.prompt).toContain("--json");
  });

  it("states the invariants an agent must not violate", () => {
    // Credentials stay local; pushes never target refs/heads; strict/label prefs exist.
    expect(skill!.prompt).toMatch(/credentials never travel/i);
    expect(skill!.prompt).toContain("refs/kanban/incoming/");
    expect(skill!.prompt).toContain(workerDispatchPrefKey("<projectId>"));
  });

  it("quotes the timeouts that match the implementation", () => {
    expect(PAIRING_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
    expect(skill!.prompt).toMatch(/10[- ]minute|10 minutes/);
    expect(WORKER_HEARTBEAT_STALE_MS).toBe(90 * 1000);
    expect(skill!.prompt).toContain("90s");
  });
});
