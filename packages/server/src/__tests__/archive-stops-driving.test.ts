/**
 * #1057 — archiving a project must STOP DRIVING IT.
 *
 * Archiving used to hide a project from the default list and change nothing else. But the
 * monitor's driven set is derived purely from preferences (`monitorDrivenProjectIds`) and never
 * consults `archivedAt`, so an archived project kept auto-starting builders, merging, refilling
 * its backlog and burning quota — with no view it appeared in to notice.
 *
 * MEASURED on 2026-09-07: `fleetops` and `My_Pet_store` had been archived since 2026-08-18 and
 * still resolved to Start Mode `monitor` three weeks later. A third `start_mode=monitor` pref
 * pointed at a project that no longer existed at all.
 *
 * The fix deliberately lives in `archiveProject` rather than in `resolveStartPolicy`: the latter
 * is a documented PURE prefMap resolver (`prefmap-resolver-purity.test.ts` forbids it a db read),
 * so it cannot see `archivedAt`. Making archive own the mode keeps the resolver pure and stops
 * the state from ever arising.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getProjectById = vi.fn();
const setProjectArchived = vi.fn();
const clearActiveProjectPreference = vi.fn();
const setPreferenceChecked = vi.fn();

vi.mock("../repositories/project.repository.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProjectById: (...a: unknown[]) => getProjectById(...a),
  setProjectArchived: (...a: unknown[]) => setProjectArchived(...a),
}));

vi.mock("../repositories/project-service.repository.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clearActiveProjectPreference: (...a: unknown[]) => clearActiveProjectPreference(...a),
}));

vi.mock("@agentic-kanban/shared/lib/checked-preference-write", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setPreferenceChecked: (...a: unknown[]) => setPreferenceChecked(...a),
}));

const { createProjectService } = await import("../services/project.service.js");
const { startModePrefKey } = await import("../services/start-policy.service.js");

const PID = "proj-1";

function service() {
  return createProjectService({ database: {} as never });
}

describe("archiving stops the monitor driving a project (#1057)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProjectById.mockResolvedValue({ id: PID, name: "fleetops" });
    setProjectArchived.mockResolvedValue(undefined);
    clearActiveProjectPreference.mockResolvedValue(undefined);
    setPreferenceChecked.mockResolvedValue({ divergence: null, objectivesRegenerated: [] });
  });

  it("writes start_mode=manual when a project is archived", async () => {
    await service().archiveProject(PID);

    expect(setProjectArchived).toHaveBeenCalledWith(PID, true, expect.anything());
    expect(setPreferenceChecked).toHaveBeenCalledTimes(1);
    const [, entries] = setPreferenceChecked.mock.calls[0] as [unknown, { key: string; value: string }[]];
    expect(entries).toEqual([{ key: startModePrefKey(PID), value: "manual" }]);
  });

  /**
   * The archive itself already happened by the time the pref write runs, so throwing here would
   * report a failure for work that was done — and leave the caller believing nothing changed.
   */
  it("still reports success (loudly warning) when the Start Mode write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setPreferenceChecked.mockRejectedValue(new Error("db locked"));

    await expect(service().archiveProject(PID)).resolves.toEqual({ id: PID });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not set its Start Mode to manual"));
    warn.mockRestore();
  });

  /**
   * Un-archiving makes a project visible; it is NOT a decision to start spending quota on its
   * backlog again. Silently restoring a drive mode is the more expensive of the two mistakes.
   */
  it("does NOT restore a drive mode on unarchive", async () => {
    await service().unarchiveProject(PID);

    expect(setProjectArchived).toHaveBeenCalledWith(PID, false, expect.anything());
    expect(setPreferenceChecked).not.toHaveBeenCalled();
  });
});
