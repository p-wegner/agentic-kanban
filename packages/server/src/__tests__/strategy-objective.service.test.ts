import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitObjectiveFile,
  deriveMonitorTunables,
  parseStrategyBullseyeConfig,
  resolveMonitorTunables,
  updateObjectiveWithStrategy,
  writeStrategyObjective,
} from "../services/strategy-objective.service.js";

const OBJECTIVE_REL = "scripts/board-monitor/objective.md";
const BASE_OBJECTIVE = [
  "Intro prose",
  "",
  "## TUNABLE TARGETS - edit these live to steer the loop",
  "- **ACTIVE_AGENTS_TARGET = 5** - old",
  "",
  "FIRST, READ YOUR RECENT MEMORY: keep this prose",
].join("\n");

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
}

describe("strategy objective translation", () => {
  it("maps bugfix-heavy bullseye weights to bugfix-only refill focus", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      activeAgentsTarget: 5,
      backlogFloor: 12,
      maxNewStartsPerCycle: 3,
      segments: [
        { id: "bugfix", label: "Bugfix", kind: "work-type", weight: 5, keywords: "bug fix regression" },
        { id: "feature", label: "Feature", kind: "work-type", weight: 2, keywords: "feature" },
        { id: "quality", label: "Quality", kind: "work-type", weight: 2, keywords: "quality" },
      ],
    }));

    expect(deriveMonitorTunables(config)).toEqual({
      activeAgentsTarget: 5,
      backlogFloor: 12,
      maxNewStartsPerCycle: 3,
      refillFocus: "bugfix-only",
    });
  });

  it("replaces only the tunables region and preserves monitor prose", () => {
    const objective = [
      "Intro prose",
      "",
      "## TUNABLE TARGETS - edit these live to steer the loop",
      "> old note",
      "- **ACTIVE_AGENTS_TARGET = 4** - old",
      "- **BACKLOG_FLOOR = 10** - old",
      "- **MAX_NEW_STARTS_PER_CYCLE = 2** - old",
      "- **REFILL_FOCUS = balanced** - old",
      "",
      "FIRST, READ YOUR RECENT MEMORY: keep this prose",
      "",
      "Each run, do work.",
    ].join("\n");
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      segments: [
        { id: "feature", label: "Feature", kind: "work-type", weight: 5, keywords: "feature" },
        { id: "bugfix", label: "Bugfix", kind: "work-type", weight: 1, keywords: "bug fix" },
      ],
    }));

    const updated = updateObjectiveWithStrategy(objective, config);

    expect(updated).toContain("<!-- STRATEGY_BULLSEYE_GENERATED_START -->");
    expect(updated).toContain("<!-- STRATEGY_BULLSEYE_GENERATED_END -->");
    expect(updated).toContain("**REFILL_FOCUS = balanced**");
    expect(updated).toContain("Feature: weight 5/5");
    expect(updated).toContain("FIRST, READ YOUR RECENT MEMORY: keep this prose");
    expect(updated).toContain("Each run, do work.");
    expect(updated).not.toContain("> old note");
  });
});

describe("writeStrategyObjective + commitObjectiveFile — auto-commit hook", () => {
  let repo: string;
  const config = JSON.stringify({ segments: [{ id: "perf", label: "REST API Performance", kind: "area", weight: 5, keywords: "performance rest api" }] });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "strategy-objective-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    mkdirSync(join(repo, "scripts", "board-monitor"), { recursive: true });
    writeFileSync(join(repo, OBJECTIVE_REL), BASE_OBJECTIVE, "utf8");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "seed"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns true and rewrites the file when the bullseye changes the tunables", () => {
    const changed = writeStrategyObjective(repo, config);
    expect(changed).toBe(true);
    const text = readFileSync(join(repo, OBJECTIVE_REL), "utf8");
    expect(text).toContain("<!-- STRATEGY_BULLSEYE_GENERATED_START -->");
    expect(text).toContain("REST API Performance: weight 5/5");
    expect(text).toContain("FIRST, READ YOUR RECENT MEMORY: keep this prose");
  });

  it("returns false (no rewrite) when there is no objective.md", () => {
    const empty = mkdtempSync(join(tmpdir(), "strategy-empty-"));
    try {
      expect(writeStrategyObjective(empty, config)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("commits ONLY objective.md, leaving an unrelated dirty file untracked", () => {
    writeStrategyObjective(repo, config);
    // an unrelated working-tree change that must NOT be swept into the commit
    writeFileSync(join(repo, "unrelated.txt"), "dirty", "utf8");

    const committed = commitObjectiveFile(repo);
    expect(committed).toBe(true);

    // objective.md is now committed (clean), unrelated.txt is still untracked
    const status = git(repo, ["status", "--porcelain"]);
    expect(status).not.toContain(OBJECTIVE_REL);
    expect(status).toContain("unrelated.txt");

    // the latest commit touched only objective.md
    const files = git(repo, ["show", "--name-only", "--pretty=format:", "HEAD"]).trim();
    expect(files).toBe(OBJECTIVE_REL);
  });

  it("is a no-op (returns false) when objective.md has no uncommitted changes", () => {
    expect(commitObjectiveFile(repo)).toBe(false);
  });
});

describe("resolveMonitorTunables — in-process monitor wiring", () => {
  it("derives tunables from a saved Strategy Bullseye", () => {
    const prefMap = new Map<string, string>([
      ["board_strategy_proj-1", JSON.stringify({
        activeAgentsTarget: 6,
        backlogFloor: 12,
        maxNewStartsPerCycle: 3,
        segments: [{ id: "bugfix", label: "Bugfix", kind: "work-type", weight: 5, keywords: "bug fix regression" }],
      })],
    ]);
    const { tunables, source } = resolveMonitorTunables(prefMap, "proj-1");
    expect(source).toBe("strategy");
    expect(tunables).toEqual({ activeAgentsTarget: 6, backlogFloor: 12, maxNewStartsPerCycle: 3, refillFocus: "bugfix-only" });
  });

  it("falls back to legacy nudge prefs (floor 1, no per-cycle cap) when no strategy exists", () => {
    const prefMap = new Map<string, string>([["nudge_wip_limit", "5"]]);
    const { tunables, source } = resolveMonitorTunables(prefMap, "proj-1");
    expect(source).toBe("prefs");
    expect(tunables.activeAgentsTarget).toBe(5);
    expect(tunables.backlogFloor).toBe(1);
    expect(tunables.maxNewStartsPerCycle).toBe(Number.POSITIVE_INFINITY);
    expect(tunables.refillFocus).toBe("balanced");
  });

  it("falls back to legacy prefs when the strategy JSON is malformed", () => {
    const prefMap = new Map<string, string>([
      ["board_strategy_proj-1", "{not valid json"],
      ["nudge_wip_limit", "3"],
    ]);
    const { tunables, source } = resolveMonitorTunables(prefMap, "proj-1");
    expect(source).toBe("prefs");
    expect(tunables.activeAgentsTarget).toBe(3);
  });
});
