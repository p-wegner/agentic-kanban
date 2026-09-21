import { afterEach, describe, expect, it } from "vitest";
import {
  abortLiveMergeTrain,
  registerLiveMergeTrain,
  resetLiveMergeTrainRegistryForTests,
  unregisterLiveMergeTrain,
} from "../services/merge-train-live-registry.js";

/**
 * #1203 — the registry now hands out a real cancellation token (an `AbortController`) per live
 * train, and `abortLiveMergeTrain` is the one way a caller (the cancel route) reaches it.
 */
describe("merge-train-live-registry abort (#1203)", () => {
  afterEach(() => {
    resetLiveMergeTrainRegistryForTests();
  });

  it("registering returns a controller whose signal starts un-aborted", () => {
    const controller = registerLiveMergeTrain({ trainId: "t1", label: "train/x-01", projectId: "p1" });
    expect(controller.signal.aborted).toBe(false);
  });

  it("abortLiveMergeTrain aborts the registered job's controller and reports true", () => {
    const controller = registerLiveMergeTrain({ trainId: "t1", label: "train/x-01", projectId: "p1" });
    const stopped = abortLiveMergeTrain("t1");
    expect(stopped).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("is a no-op returning false for a train not registered in this process", () => {
    expect(abortLiveMergeTrain("does-not-exist")).toBe(false);
  });

  it("is a no-op returning false after the job has been unregistered", () => {
    registerLiveMergeTrain({ trainId: "t1", label: "train/x-01", projectId: "p1" });
    unregisterLiveMergeTrain("t1");
    expect(abortLiveMergeTrain("t1")).toBe(false);
  });

  it("re-registering the same id mints a FRESH controller, not the old one", () => {
    const first = registerLiveMergeTrain({ trainId: "t1", label: "train/x-01", projectId: "p1" });
    abortLiveMergeTrain("t1");
    expect(first.signal.aborted).toBe(true);

    const second = registerLiveMergeTrain({ trainId: "t1", label: "train/x-02", projectId: "p1" });
    expect(second.signal.aborted).toBe(false);
    expect(second).not.toBe(first);
  });
});
