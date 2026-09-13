import { describe, expect, it, vi } from "vitest";

vi.mock("../repositories/preferences.repository.js", () => ({
  getAllPreferencesCached: vi.fn(async () => []),
}));

import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { WorkspaceError } from "./workspace-error.js";
import {
  assertProjectNotQuiesced,
  getQuiesceReason,
  isProjectQuiesced,
  projectQuiescedPrefKey,
  projectQuiesceReasonPrefKey,
  quiesceRefusalMessage,
} from "./quiesce.service.js";

const PID = "11111111-2222-3333-4444-555555555555";

function prefs(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

function mockPrefRows(entries: Record<string, string>): void {
  vi.mocked(getAllPreferencesCached).mockResolvedValueOnce(
    Object.entries(entries).map(([key, value]) => ({ key, value })) as never,
  );
}

describe("quiesce.service (#1108)", () => {
  it("key builders round-trip", () => {
    expect(projectQuiescedPrefKey(PID)).toBe(`project_quiesced_${PID}`);
    expect(projectQuiesceReasonPrefKey(PID)).toBe(`project_quiesce_reason_${PID}`);
  });

  it("isProjectQuiesced is false when unset", () => {
    expect(isProjectQuiesced(prefs({}), PID)).toBe(false);
  });

  it("isProjectQuiesced is true when the project's key is 'true'", () => {
    expect(isProjectQuiesced(prefs({ [`project_quiesced_${PID}`]: "true" }), PID)).toBe(true);
  });

  it("a DIFFERENT project's quiesce flag does not leak", () => {
    const other = "99999999-8888-7777-6666-555555555555";
    expect(isProjectQuiesced(prefs({ [`project_quiesced_${other}`]: "true" }), PID)).toBe(false);
  });

  it("getQuiesceReason returns the trimmed reason, or undefined when blank/unset", () => {
    expect(getQuiesceReason(prefs({}), PID)).toBeUndefined();
    expect(getQuiesceReason(prefs({ [`project_quiesce_reason_${PID}`]: "   " }), PID)).toBeUndefined();
    expect(getQuiesceReason(prefs({ [`project_quiesce_reason_${PID}`]: "promoting master" }), PID)).toBe(
      "promoting master",
    );
  });

  it("quiesceRefusalMessage names the action and the clearing key, with an optional reason", () => {
    expect(quiesceRefusalMessage(PID, undefined, "relaunch")).toContain("relaunch is held");
    expect(quiesceRefusalMessage(PID, undefined, "relaunch")).toContain(`project_quiesced_${PID}`);
    expect(quiesceRefusalMessage(PID, "promoting master", "workspace creation")).toContain(
      "promoting master",
    );
  });

  describe("assertProjectNotQuiesced", () => {
    it("no-ops for a null projectId", async () => {
      await expect(assertProjectNotQuiesced({} as never, null, "relaunch")).resolves.toBeUndefined();
      expect(getAllPreferencesCached).not.toHaveBeenCalled();
    });

    it("resolves when the project is not quiesced", async () => {
      mockPrefRows({});
      await expect(assertProjectNotQuiesced({} as never, PID, "relaunch")).resolves.toBeUndefined();
    });

    it("throws a CONFLICT WorkspaceError carrying PROJECT_QUIESCED when quiesced", async () => {
      mockPrefRows({
        [`project_quiesced_${PID}`]: "true",
        [`project_quiesce_reason_${PID}`]: "promoting master",
      });
      await expect(assertProjectNotQuiesced({} as never, PID, "relaunch")).rejects.toMatchObject({
        code: "CONFLICT",
        data: { code: "PROJECT_QUIESCED", projectId: PID },
      });
      expect(WorkspaceError).toBeDefined(); // sanity: imported for the matcher's constructor shape
    });
  });
});
