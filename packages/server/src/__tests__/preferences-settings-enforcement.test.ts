// @covers preferences.routes.settingsEnforcement
//
// #648 item 5. `PUT /api/preferences/settings` is the one write path that decides which
// keys the board will accept at all — the #874 loud-422-with-partial-persist contract, the
// `applied` list the client believes, the project-scoped dynamic keys, and the #903
// provider/Bullseye divergence guard that rejects BEFORE persisting anything. All of it
// was tested only in `preferences.test.ts`, which `scripts/test-mine.mjs` EXCLUDES for
// #173 load-flakiness — so the pre-merge gate has never once checked it, and neither has
// anything else in the fast loop (`api-preferences.test.ts` covers only active-project,
// and `settings-registry-keys.test.ts` proves the key SET, not that the route enforces it).
//
// This is the fast twin: the enforcement cases, in a file the gate actually runs. It is a
// PORT, not a replacement — the excluded file keeps its wider surface (provider-profile
// reads, agent-profile health, preflight). One correction to the ticket's framing: the
// excluded file is not stale on #874, whose 422 semantics it does assert; what it never
// covered is the #903 divergence guard, which is new here.

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { projects } from "@agentic-kanban/shared/schema";
import { createPreferencesRoute } from "../routes/preferences.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/preferences", createPreferencesRoute(db));
  });
}

/** A Bullseye that actually SELECTS: `selectPolicyByPriority` needs a real policy shape. */
const bullseyeBlob = (provider: string, profileName: string) =>
  JSON.stringify({
    providerPolicies: [
      { id: `${provider}:${profileName}`, provider, profileName, label: `${provider} ${profileName}`, mode: "fill", headroomPct: 0, notes: "" },
    ],
  });

type SettingsBody = Record<string, string>;
type PutResult = { ok?: boolean; applied?: string[]; droppedKeys?: string[]; error?: string; divergence?: unknown };

async function putSettings(app: ReturnType<typeof createTestApp>["app"], body: SettingsBody) {
  const res = await app.request("/api/preferences/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as PutResult };
}

async function getSettings(app: ReturnType<typeof createTestApp>["app"]) {
  const res = await app.request("/api/preferences/settings");
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, string | undefined>;
}

describe("PUT /api/preferences/settings — key enforcement (#648)", () => {
  it("returns 200 with the applied keys and no droppedKeys when everything is valid", async () => {
    const { app } = createTestApp();

    const { status, body } = await putSettings(app, { agent_command: "ok", claude_profile: "mock" });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.applied).toEqual(expect.arrayContaining(["agent_command", "claude_profile"]));
    expect(body.droppedKeys).toBeUndefined();
  });

  it("rejects an unknown key LOUDLY (422) while still persisting the valid ones", async () => {
    // #874: the pre-fix behaviour was a silent drop, which is how `auto_rebase_on_continue`
    // and `skip_preflight` appeared to save and then did nothing. The partial apply is
    // deliberate — the user's other edits in the same save must not be lost to one typo.
    const { app } = createTestApp();

    const { status, body } = await putSettings(app, {
      agent_command: "test",
      malicious_key: "should be rejected",
    });

    expect(status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.droppedKeys).toEqual(["malicious_key"]);
    expect(body.applied).toEqual(["agent_command"]);
    expect(body.error).toContain("malicious_key");

    const settings = await getSettings(app);
    expect(settings.agent_command).toBe("test");
    expect(settings.malicious_key).toBeUndefined();
  });

  it("names every rejected key, not just the first", async () => {
    const { app } = createTestApp();

    const { status, body } = await putSettings(app, {
      agent_command: "test",
      bogus_one: "x",
      bogus_two: "y",
    });

    expect(status).toBe(422);
    expect(body.droppedKeys).toEqual(expect.arrayContaining(["bogus_one", "bogus_two"]));
    expect(body.applied).toEqual(["agent_command"]);
  });

  it("upserts rather than appending", async () => {
    const { app } = createTestApp();

    await putSettings(app, { agent_command: "first" });
    await putSettings(app, { agent_command: "second" });

    expect((await getSettings(app)).agent_command).toBe("second");
  });

  it("accepts the agent/profile keys across all four providers", async () => {
    const { app } = createTestApp();

    const { status } = await putSettings(app, {
      agent_command: "custom-agent",
      agent_args: "--flag value",
      output_parser: "custom",
      claude_profile: "mock",
      pi_profile: "local",
      copilot_profile: "gpt-5.2",
    });
    expect(status).toBe(200);

    const settings = await getSettings(app);
    expect(settings.agent_command).toBe("custom-agent");
    expect(settings.agent_args).toBe("--flag value");
    expect(settings.output_parser).toBe("custom");
    expect(settings.claude_profile).toBe("mock");
    expect(settings.pi_profile).toBe("local");
    expect(settings.copilot_profile).toBe("gpt-5.2");
  });
});

describe("PUT /api/preferences/settings — project-scoped dynamic keys (#648)", () => {
  // These are not in SETTINGS_REGISTRY; they pass through `isAllowedDynamicKey`, which
  // matches on a registered PREFIX. A prefix that was never registered is indistinguishable
  // from a typo and gets the same 422 — that is the whole point of the mechanism, and the
  // reason a new project-scoped pref has to be added to PROJECT_SCOPED_KEY_PREFIXES.
  const cases: [string, (id: string) => string, string][] = [
    ["backlog filter presets", (id) => `backlog_filter_presets_${id}`, JSON.stringify([{ id: "preset-1", name: "High bugs" }])],
    ["board saved views", (id) => `board_saved_views_${id}`, JSON.stringify([{ id: "view-1", name: "Review queue", state: { searchQuery: "review" } }])],
    ["launch templates", (id) => `launch_templates_${id}`, JSON.stringify([{ id: "lt-1", name: "Standard", options: { planMode: true } }])],
    ["agent presets", (id) => `agent_presets_${id}`, JSON.stringify([{ id: "ap-1", name: "Claude Opus", provider: "claude", model: "opus" }])],
  ];

  for (const [label, keyFor, value] of cases) {
    it(`stores project-scoped ${label} verbatim`, async () => {
      const { app } = createTestApp();
      const key = keyFor(randomUUID());

      const { status } = await putSettings(app, { [key]: value });
      expect(status).toBe(200);

      // Stored as an opaque string: the route must not reformat a JSON blob it does not own.
      expect((await getSettings(app))[key]).toBe(value);
    });
  }

  it("rejects a project-scoped key whose prefix was never registered", async () => {
    const { app } = createTestApp();

    const key = `not_a_registered_prefix_${randomUUID()}`;
    const { status, body } = await putSettings(app, { [key]: "x" });

    expect(status).toBe(422);
    expect(body.droppedKeys).toEqual([key]);
  });
});

describe("PUT /api/preferences/settings — provider divergence guard (#648/#903)", () => {
  async function seedBullseyeProject(
    app: ReturnType<typeof createTestApp>["app"],
    db: ReturnType<typeof createTestApp>["db"],
    opts: { archived?: boolean } = {},
  ) {
    const projectId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(projects).values({
      id: projectId, name: "Guarded", repoPath: `/repo/${projectId}`, repoName: "repo",
      defaultBranch: "master", archivedAt: opts.archived ? now : null, createdAt: now, updatedAt: now,
    });
    const res = await putSettings(app, { [`board_strategy_${projectId}`]: bullseyeBlob("claude", "work") });
    expect(res.status).toBe(200);
    return projectId;
  }

  it("refuses a provider write that contradicts a live project's Bullseye, persisting NOTHING", async () => {
    const { app, db } = createTestApp();
    await seedBullseyeProject(app, db);

    // This is the drift that stalled a multi-cycle run: the settings pref says codex,
    // the Bullseye says claude, and which one wins depends on which consumer you ask.
    const { status, body } = await putSettings(app, { provider: "codex", agent_command: "should-not-persist" });

    expect(status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.divergence).toBeDefined();
    // The difference from the #874 path: this guard rejects BEFORE persisting, so
    // `applied` is empty and the unrelated key in the same request is NOT written.
    expect(body.applied).toEqual([]);
    expect((await getSettings(app)).agent_command).toBeUndefined();
  });

  it("accepts a provider write that AGREES with the Bullseye", async () => {
    const { app, db } = createTestApp();
    await seedBullseyeProject(app, db);

    const { status } = await putSettings(app, { provider: "claude", claude_profile: "work" });

    expect(status).toBe(200);
    expect((await getSettings(app)).provider).toBe("claude");
  });

  it("lets a provider-unrelated save through even when prefs already diverge", async () => {
    // The guard only fires when the WRITE touches a provider/profile key. A user
    // toggling something else must not be blocked by drift they did not create.
    const { app, db } = createTestApp();
    await seedBullseyeProject(app, db);

    const { status } = await putSettings(app, { agent_args: "--unrelated" });

    expect(status).toBe(200);
    expect((await getSettings(app)).agent_args).toBe("--unrelated");
  });

  it("ignores a Bullseye whose project row does not exist", async () => {
    // `board_strategy_<id>` outlives its project — nothing sweeps the pref on delete.
    // Gating a live write against a board nobody can reach would be unfixable from the UI.
    const { app } = createTestApp();
    const { status } = await putSettings(app, { [`board_strategy_${randomUUID()}`]: bullseyeBlob("claude", "work") });
    expect(status).toBe(200);

    expect((await putSettings(app, { provider: "codex" })).status).toBe(200);
  });

  it("ignores an ARCHIVED project's Bullseye", async () => {
    const { app, db } = createTestApp();
    await seedBullseyeProject(app, db, { archived: true });

    expect((await putSettings(app, { provider: "codex" })).status).toBe(200);
  });

  it("does not fire when two live projects' Bullseyes disagree — there is no invariant to enforce", async () => {
    const { app, db } = createTestApp();
    await seedBullseyeProject(app, db);
    const otherId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(projects).values({
      id: otherId, name: "Other", repoPath: `/repo/${otherId}`, repoName: "repo",
      defaultBranch: "master", createdAt: now, updatedAt: now,
    });
    await putSettings(app, { [`board_strategy_${otherId}`]: bullseyeBlob("codex", "team") });

    // A global pref cannot satisfy both boards, so rejecting would make the setting
    // unwritable rather than coherent.
    expect((await putSettings(app, { provider: "codex" })).status).toBe(200);
  });
});
