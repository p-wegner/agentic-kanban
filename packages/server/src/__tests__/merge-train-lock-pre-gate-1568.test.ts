import { describe, expect, it } from "vitest";
import { createSuspendableRepoLock } from "../services/merge-queue-repo-lock.js";

function fakeAcquire() {
  const state = { held: false, acquired: 0 };
  const acquire = async () => {
    state.held = true;
    state.acquired++;
    return { heartbeat: () => undefined, release: () => { state.held = false; } } as never;
  };
  return { state, acquire };
}

describe("#1568 the train holds the repo lock for assembly and landing, not its gate", () => {
  it("releases at gate start and retakes only to land", async () => {
    const { state, acquire } = fakeAcquire();
    const lock = createSuspendableRepoLock(acquire, new AbortController().signal);
    await lock.acquireInitial();
    expect(state.held).toBe(true);
    await lock.drop();
    expect(state.held).toBe(false);
    await lock.beginLanding();
    expect(state.held).toBe(true);
    await lock.drop(); // a sibling's gate must not free a landing in progress
    expect(state.held).toBe(true);
    await lock.endLanding();
    expect(state.held).toBe(false);
    expect(state.acquired).toBe(2);
  });

  it("does not retake after an operator cancel", async () => {
    const { state, acquire } = fakeAcquire();
    const ac = new AbortController();
    const lock = createSuspendableRepoLock(acquire, ac.signal);
    await lock.acquireInitial();
    await lock.drop();
    ac.abort();
    await lock.beginLanding();
    expect(state.held).toBe(false);
  });
});
