import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  containerProfileRoot,
  encodeTranscriptCwd,
  hostTranscriptDir,
  provisionContainerProfile,
  transcriptMount,
  writeContainerMcpConfig,
} from "../services/container-profile.service.js";

let home: string;
let sourceDir: string;
let stateDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "container-profile-"));
  sourceDir = join(home, ".claude");
  stateDir = join(home, ".agentic-kanban");
  mkdirSync(sourceDir, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seedHostProfile() {
  writeFileSync(join(sourceDir, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"tok"}}');
  writeFileSync(join(sourceDir, "settings.json"), '{"a":1}');
  writeFileSync(join(sourceDir, "settings_anth.json"), '{"env":{"ANTHROPIC_API_KEY":"k"}}');
  writeFileSync(join(sourceDir, "settings_other.json"), '{"env":{"ANTHROPIC_API_KEY":"other"}}');
  writeFileSync(join(home, ".claude.json"), '{"onboarded":true}');
  // Material a builder must NOT get: other sessions' transcripts, personal skills.
  mkdirSync(join(sourceDir, "projects", "C--other-repo"), { recursive: true });
  writeFileSync(join(sourceDir, "projects", "C--other-repo", "s1.jsonl"), '{"secret":true}');
  mkdirSync(join(sourceDir, "skills", "personal"), { recursive: true });
  writeFileSync(join(sourceDir, "skills", "personal", "SKILL.md"), "personal");
}

describe("provisionContainerProfile — narrow profile (#133)", () => {
  it("seeds only the auth/config files a builder needs", () => {
    seedHostProfile();

    const profile = provisionContainerProfile({ sourceDir, profileKey: "default", hostHome: home, stateDir });

    expect(readdirSync(profile.hostDir).sort()).toEqual([".claude.json", ".credentials.json", "settings.json"]);
  });

  it("does NOT expose other sessions' transcripts or personal skills", () => {
    seedHostProfile();

    const profile = provisionContainerProfile({ sourceDir, profileKey: "default", hostHome: home, stateDir });

    expect(existsSync(join(profile.hostDir, "projects"))).toBe(false);
    expect(existsSync(join(profile.hostDir, "skills"))).toBe(false);
  });

  it("seeds .claude.json from the sibling location (#134)", () => {
    // The whole point of #134: `.claude.json` sits NEXT TO ~/.claude, so mounting
    // the directory never carried it and every turn printed a config-not-found
    // preamble to stderr.
    seedHostProfile();

    const profile = provisionContainerProfile({ sourceDir, profileKey: "default", hostHome: home, stateDir });

    expect(readFileSync(join(profile.hostDir, ".claude.json"), "utf8")).toBe('{"onboarded":true}');
  });

  it("prefers a .claude.json already inside the config dir over the sibling", () => {
    seedHostProfile();
    writeFileSync(join(sourceDir, ".claude.json"), '{"inside":true}');

    const profile = provisionContainerProfile({ sourceDir, profileKey: "default", hostHome: home, stateDir });

    expect(readFileSync(join(profile.hostDir, ".claude.json"), "utf8")).toBe('{"inside":true}');
  });

  it("seeds only the SELECTED settings profile, not every profile on the host", () => {
    seedHostProfile();

    const profile = provisionContainerProfile({
      sourceDir,
      profileKey: "anth",
      settingsProfile: "anth",
      hostHome: home,
      stateDir,
    });

    expect(existsSync(join(profile.hostDir, "settings_anth.json"))).toBe(true);
    expect(existsSync(join(profile.hostDir, "settings_other.json"))).toBe(false);
  });

  it("isolates profiles from each other so subscription rotation stays separate", () => {
    seedHostProfile();

    const a = provisionContainerProfile({ sourceDir, profileKey: "max1", hostHome: home, stateDir });
    const b = provisionContainerProfile({ sourceDir, profileKey: "max2", hostHome: home, stateDir });

    expect(a.hostDir).not.toBe(b.hostDir);
    expect(a.hostDir.startsWith(containerProfileRoot(stateDir))).toBe(true);
  });

  it("reseeds on every provision so the container's copy tracks the host's", () => {
    seedHostProfile();
    const first = provisionContainerProfile({ sourceDir, profileKey: "default", hostHome: home, stateDir });
    expect(readFileSync(join(first.hostDir, ".credentials.json"), "utf8")).toContain("tok");

    // Host re-login rotates the credential.
    writeFileSync(join(sourceDir, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"rotated"}}');
    const second = provisionContainerProfile({ sourceDir, profileKey: "default", hostHome: home, stateDir });

    expect(readFileSync(join(second.hostDir, ".credentials.json"), "utf8")).toContain("rotated");
  });

  it("tolerates a source profile with nothing to seed", () => {
    const profile = provisionContainerProfile({ sourceDir, profileKey: "default", hostHome: home, stateDir });
    expect(profile.seeded).toEqual([]);
  });

  it("cannot escape the profile root via a crafted profile name", () => {
    const profile = provisionContainerProfile({
      sourceDir,
      profileKey: "../../escape",
      hostHome: home,
      stateDir,
    });
    expect(profile.hostDir.startsWith(containerProfileRoot(stateDir))).toBe(true);
    expect(profile.hostDir).not.toContain("..");
  });
});

describe("writeContainerMcpConfig — reachable board MCP (#136)", () => {
  it("describes an HTTP transport on the host gateway, not a host stdio command", () => {
    // The stdio config names a command that does not exist in the container, and
    // path-translating it is a dead end because the MCP server opens the DB through
    // a natively-compiled Windows better-sqlite3 binding.
    const path = writeContainerMcpConfig({ hostTmp: home, workspaceId: "ws1", port: 51234, token: "tok" });
    const config = JSON.parse(readFileSync(path, "utf8"));

    expect(config.mcpServers["agentic-kanban"]).toEqual({
      type: "http",
      url: "http://host.docker.internal:51234/mcp",
      headers: { Authorization: "Bearer tok" },
    });
    expect(JSON.stringify(config)).not.toContain("command");
  });

  it("writes one config per workspace so concurrent builders never race", () => {
    const a = writeContainerMcpConfig({ hostTmp: home, workspaceId: "ws1", port: 1, token: "t" });
    const b = writeContainerMcpConfig({ hostTmp: home, workspaceId: "ws2", port: 1, token: "t" });
    expect(a).not.toBe(b);
  });

  it("writes into the host temp dir, which is already mounted", () => {
    const path = writeContainerMcpConfig({ hostTmp: home, workspaceId: "ws1", port: 1, token: "t" });
    expect(path.startsWith(home)).toBe(true);
  });
});

describe("transcriptMount — containerized sessions stay inspectable", () => {
  it("maps the container's transcript dir onto the host's real one for that worktree", () => {
    // session-inspector / fleet-analysis resolve ~/.claude/projects/<host-cwd-encoding>.
    // Narrowing the profile moves CLAUDE_CONFIG_DIR, so without this mapping a
    // containerized builder's transcripts would land under the CONTAINER's cwd
    // encoding inside the board-owned profile dir — invisible to every reader, and
    // the compounding-engineering loop silently loses its input.
    const mount = transcriptMount({
      worktreePath: "C:/projects/andrena/exp/taskflow",
      remoteWorkspaceFolder: "/workspaces/taskflow",
      containerConfigDir: "/home/node/.claude",
      hostHome: home,
    });

    expect(mount.source).toBe(
      join(home, ".claude", "projects", "C--projects-andrena-exp-taskflow").replace(/\\/g, "/"),
    );
    expect(mount.target).toBe("/home/node/.claude/projects/-workspaces-taskflow");
  });

  it("creates the host transcript dir so it can be bind-mounted", () => {
    const dir = hostTranscriptDir("C:/projects/app", home);
    expect(existsSync(dir)).toBe(true);
  });

  it("encodes cwds the way Claude does (: \\ / all become -)", () => {
    // Must match butler-transcripts.service.ts, which reads these back.
    expect(encodeTranscriptCwd("C:\\projects\\app")).toBe("C--projects-app");
    expect(encodeTranscriptCwd("/workspaces/app")).toBe("-workspaces-app");
  });

  it("gives each worktree its OWN transcript dir, not the whole projects tree", () => {
    const a = transcriptMount({
      worktreePath: "C:/projects/a",
      remoteWorkspaceFolder: "/workspaces/a",
      containerConfigDir: "/home/node/.claude",
      hostHome: home,
    });
    const b = transcriptMount({
      worktreePath: "C:/projects/b",
      remoteWorkspaceFolder: "/workspaces/b",
      containerConfigDir: "/home/node/.claude",
      hostHome: home,
    });

    expect(a.source).not.toBe(b.source);
    expect(a.source.endsWith("projects")).toBe(false);
  });
});
