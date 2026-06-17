import { describe, it, expect, vi } from "vitest";
import {
  conductorCronPrefKey,
  parseConductorSchedule,
  serializeConductorSchedule,
  resolveConductorSchedule,
  isConductorCronDue,
  runDueConductorCrons,
  type ConductorCronProject,
} from "./conductor-schedule.service.js";

const PID = "11111111-2222-3333-4444-555555555555";

describe("conductorCronPrefKey", () => {
  it("namespaces the pref by project id", () => {
    expect(conductorCronPrefKey(PID)).toBe(`conductor_cron_${PID}`);
  });
});

describe("parseConductorSchedule", () => {
  it("returns disabled defaults for null/empty/garbage", () => {
    for (const raw of [null, undefined, "", "not json", "{"]) {
      expect(parseConductorSchedule(raw)).toEqual({ enabled: false, cron: "", agent: "claude", lastFiredAt: null });
    }
  });

  it("normalizes partial/invalid fields", () => {
    expect(parseConductorSchedule(JSON.stringify({ enabled: "yes", cron: "  */5 * * * *  ", agent: "weird", lastFiredAt: "" }))).toEqual({
      enabled: false, // only literal true counts
      cron: "*/5 * * * *", // trimmed
      agent: "claude", // unknown agent → claude
      lastFiredAt: null, // empty string → null
    });
  });

  it("round-trips a valid schedule", () => {
    const s = { enabled: true, cron: "0 * * * *", agent: "codex" as const, lastFiredAt: "2026-06-18T00:00:00.000Z" };
    expect(parseConductorSchedule(serializeConductorSchedule(s))).toEqual(s);
  });
});

describe("resolveConductorSchedule", () => {
  const now = new Date("2026-06-18T12:00:00.000Z");

  it("flags an enabled schedule with no cron", () => {
    const r = resolveConductorSchedule(JSON.stringify({ enabled: true, cron: "" }), { now });
    expect(r.valid).toBe(false);
    expect(r.error).toBe("No cron expression set");
    expect(r.nextFireAt).toBeNull();
  });

  it("surfaces a cron validation error", () => {
    const r = resolveConductorSchedule(JSON.stringify({ enabled: true, cron: "bogus" }), { now });
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.description).toBeNull();
  });

  it("describes a valid cron and computes the next fire from now when never fired", () => {
    const r = resolveConductorSchedule(JSON.stringify({ enabled: true, cron: "*/30 * * * *" }), { now });
    expect(r.valid).toBe(true);
    expect(r.error).toBeNull();
    expect(r.description).toBe("Every 30 minutes");
    // Next half-hour boundary strictly after 12:00 is 12:30.
    expect(r.nextFireAt).toBe("2026-06-18T12:30:00.000Z");
  });

  it("anchors the next fire on lastFiredAt when present", () => {
    const r = resolveConductorSchedule(
      JSON.stringify({ enabled: true, cron: "0 * * * *", lastFiredAt: "2026-06-18T12:00:00.000Z" }),
      { now },
    );
    expect(r.nextFireAt).toBe("2026-06-18T13:00:00.000Z");
  });
});

describe("isConductorCronDue", () => {
  const now = new Date("2026-06-18T12:30:00.000Z");

  it("is not due when disabled", () => {
    expect(isConductorCronDue({ enabled: false, cron: "*/30 * * * *", agent: "claude", lastFiredAt: null }, now)).toBe(false);
  });

  it("is not due with no/invalid cron", () => {
    expect(isConductorCronDue({ enabled: true, cron: "", agent: "claude", lastFiredAt: null }, now)).toBe(false);
    expect(isConductorCronDue({ enabled: true, cron: "nope", agent: "claude", lastFiredAt: null }, now)).toBe(false);
  });

  it("is due at a matching minute when never fired", () => {
    // 12:30 matches */30; anchor is now-60s (12:29) → next match 12:30 ≤ now.
    expect(isConductorCronDue({ enabled: true, cron: "*/30 * * * *", agent: "claude", lastFiredAt: null }, now)).toBe(true);
  });

  it("is not due before the next boundary arrives", () => {
    const before = new Date("2026-06-18T12:15:00.000Z");
    expect(isConductorCronDue({ enabled: true, cron: "*/30 * * * *", agent: "claude", lastFiredAt: null }, before)).toBe(false);
  });

  it("respects lastFiredAt so it does not re-fire within the same window", () => {
    // Already fired at 12:30; next match is 13:00, which is after now → not due.
    expect(
      isConductorCronDue(
        { enabled: true, cron: "*/30 * * * *", agent: "claude", lastFiredAt: "2026-06-18T12:30:00.000Z" },
        now,
      ),
    ).toBe(false);
  });
});

describe("runDueConductorCrons", () => {
  const now = new Date("2026-06-18T12:30:00.000Z");
  const dueSchedule = serializeConductorSchedule({ enabled: true, cron: "*/30 * * * *", agent: "codex", lastFiredAt: null });

  function makeDeps(overrides: Partial<Parameters<typeof runDueConductorCrons>[0]> & { projects: ConductorCronProject[]; prefs: Record<string, string | null> }) {
    const prefs = { ...overrides.prefs };
    const fire = overrides.fire ?? vi.fn(() => ({ ok: true, pid: 4242 }));
    const setSchedulePref = vi.fn(async (projectId: string, value: string) => { prefs[projectId] = value; });
    return {
      deps: {
        now,
        listProjects: async () => overrides.projects,
        getSchedulePref: async (projectId: string) => prefs[projectId] ?? null,
        setSchedulePref,
        fire,
        isAvailable: overrides.isAvailable ?? (() => true),
        isAlive: overrides.isAlive ?? (() => false),
      },
      fire,
      setSchedulePref,
      prefs,
    };
  }

  it("fires a due project's cycle and records the fire time", async () => {
    const { deps, fire, setSchedulePref, prefs } = makeDeps({
      projects: [{ projectId: PID, repoPath: "/repo" }],
      prefs: { [PID]: dueSchedule },
    });
    const results = await runDueConductorCrons(deps);
    expect(fire).toHaveBeenCalledWith("/repo", "codex");
    expect(results).toEqual([{ projectId: PID, fired: true, skipped: undefined, pid: 4242, error: undefined }]);
    expect(setSchedulePref).toHaveBeenCalledTimes(1);
    expect(parseConductorSchedule(prefs[PID]).lastFiredAt).toBe(now.toISOString());
  });

  it("skips a project with no loop on disk and does not record a fire", async () => {
    const { deps, fire, setSchedulePref } = makeDeps({
      projects: [{ projectId: PID, repoPath: "/repo" }],
      prefs: { [PID]: dueSchedule },
      isAvailable: () => false,
    });
    const results = await runDueConductorCrons(deps);
    expect(fire).not.toHaveBeenCalled();
    expect(setSchedulePref).not.toHaveBeenCalled();
    expect(results).toEqual([{ projectId: PID, fired: false, skipped: "not_available" }]);
  });

  it("does not double-drive when a Conductor is already alive, but still advances the schedule", async () => {
    const { deps, fire, prefs } = makeDeps({
      projects: [{ projectId: PID, repoPath: "/repo" }],
      prefs: { [PID]: dueSchedule },
      isAlive: () => true,
    });
    const results = await runDueConductorCrons(deps);
    expect(fire).not.toHaveBeenCalled();
    expect(results).toEqual([{ projectId: PID, fired: false, skipped: "already_running" }]);
    expect(parseConductorSchedule(prefs[PID]).lastFiredAt).toBe(now.toISOString());
  });

  it("reports a failed spawn", async () => {
    const { deps } = makeDeps({
      projects: [{ projectId: PID, repoPath: "/repo" }],
      prefs: { [PID]: dueSchedule },
      fire: vi.fn(() => ({ ok: false, pid: null, error: "boom" })),
    });
    const results = await runDueConductorCrons(deps);
    expect(results[0]).toMatchObject({ fired: false, skipped: "fire_failed", error: "boom" });
  });

  it("ignores projects that are not due", async () => {
    const { deps, fire, setSchedulePref } = makeDeps({
      projects: [{ projectId: PID, repoPath: "/repo" }],
      prefs: { [PID]: serializeConductorSchedule({ enabled: false, cron: "*/30 * * * *", agent: "claude", lastFiredAt: null }) },
    });
    const results = await runDueConductorCrons(deps);
    expect(fire).not.toHaveBeenCalled();
    expect(setSchedulePref).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});
