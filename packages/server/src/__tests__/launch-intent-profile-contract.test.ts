/**
 * #1454 contract: a launch intent as the board builds it (`buildLaunchIntent`, the
 * agent-dispatch path) survives the worker's wire parse and resolves against the worker's
 * local profiles. A board/worker provider-vocabulary drift (executor id `claude-code` vs
 * profile provider `claude`) fails HERE instead of refusing every pinned launch.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBoardToWorkerMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { buildRemoteLaunchSpec } from "../services/remote-launch-spec.js";
import { applyProfileToSpec, PROFILE_UNKNOWN_PREFIX } from "../worker/worker-profiles.js";

function workerSideSpec(provider: string | undefined, command: string, profileName: string) {
  const spec = buildRemoteLaunchSpec({
    config: { command, args: ["-p"] },
    env: {},
    cwd: "/work",
    provider,
    profileName,
    trueRemote: true,
    explicitCommand: false,
  });
  // Through JSON, exactly as the frame travels.
  const parsed = parseBoardToWorkerMessage(JSON.parse(JSON.stringify({ type: "assign", sessionId: "s1", spec })));
  if (!parsed || parsed.type !== "assign") throw new Error("assign frame was dropped by the worker parser");
  return parsed.spec;
}

describe("board launch intent -> worker profile resolution (#1454)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ak-intent-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings_anth.json"), "{}");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "team.config.toml"), "");
  });

  it.each(["claude-code", "claude"])("claude executor id '%s' resolves a pinned claude profile", (provider) => {
    const spec = workerSideSpec(provider, "/usr/bin/claude", "anth");
    expect(spec.intent?.profile).toBe("anth");
    const res = applyProfileToSpec(spec, { home });
    expect(res.ok).toBe(true);
  });

  it("codex executor id resolves a pinned codex profile", () => {
    const spec = workerSideSpec("codex", "/usr/bin/codex", "team");
    expect(spec.intent?.provider).toBe("codex");
    expect(applyProfileToSpec(spec, { home }).ok).toBe(true);
  });

  it("copilot has no machine-local profiles: a pin is refused with the profile-unknown prefix", () => {
    const spec = workerSideSpec("copilot", "/usr/bin/copilot", "anth");
    const res = applyProfileToSpec(spec, { home });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.startsWith(PROFILE_UNKNOWN_PREFIX)).toBe(true);
  });

  it("a claude pin is not satisfied by a codex profile of the same name", () => {
    const spec = workerSideSpec("claude-code", "/usr/bin/claude", "team");
    expect(applyProfileToSpec(spec, { home }).ok).toBe(false);
  });
});
