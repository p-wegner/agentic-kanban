import { describe, expect, it } from "vitest";
import { formFromWorker, pinnedNote, settingsFromForm, splitCsv } from "./workerSettingsForm.js";

const current = { maxConcurrency: 2, labels: ["linux"], providers: ["claude"] };

describe("worker settings form (#1381)", () => {
  it("starts from the worker's reported values and prefers what the board already holds", () => {
    expect(formFromWorker(undefined, current)).toMatchObject({ maxConcurrency: "2", labels: "linux", providers: "claude", drain: false });
    expect(formFromWorker({ maxConcurrency: 5, labels: ["gpu", "linux"], drain: true }, current))
      .toMatchObject({ maxConcurrency: "5", labels: "gpu, linux", drain: true });
  });

  it("turns the form into a PUT body, de-duplicating lists", () => {
    const form = { ...formFromWorker(undefined, current), maxConcurrency: "4", labels: "docker, docker , linux", profileAlias: "default=anth" };
    expect(settingsFromForm(form)).toEqual({
      settings: {
        maxConcurrency: 4, labels: ["docker", "linux"], providers: ["claude"], profileAlias: ["default=anth"],
        allowedProjects: [], deniedProjects: [], drain: false,
      },
    });
    expect(splitCsv(" a,, b ")).toEqual(["a", "b"]);
  });

  it("rejects bad concurrency and malformed aliases instead of sending them", () => {
    const base = formFromWorker(undefined, current);
    expect(settingsFromForm({ ...base, maxConcurrency: "0" })).toHaveProperty("error");
    expect(settingsFromForm({ ...base, maxConcurrency: "2.5" })).toHaveProperty("error");
    expect(settingsFromForm({ ...base, profileAlias: "nonsense" })).toHaveProperty("error");
  });

  it("explains a flag-pinned key and nothing else", () => {
    expect(pinnedNote("labels", ["labels"])).toContain("start flag");
    expect(pinnedNote("maxConcurrency", ["labels"])).toBeNull();
  });
});
