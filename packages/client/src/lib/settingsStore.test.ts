import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { getSettings, invalidateSettings, setSettings, setProjectPref } from "./settingsStore.js";
import { apiFetch } from "./api.js";

vi.mock("./api.js", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = apiFetch as unknown as Mock;

describe("settingsStore", () => {
  beforeEach(() => {
    invalidateSettings();
    apiFetchMock.mockReset();
  });

  it("dedupes concurrent callers into one request", async () => {
    apiFetchMock.mockResolvedValue({ provider: "claude" });
    const [a, b, c] = await Promise.all([getSettings(), getSettings(), getSettings()]);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith("/api/preferences/settings");
    expect(a.provider).toBe("claude");
    expect(b.provider).toBe("claude");
    expect(c.provider).toBe("claude");
  });

  it("serves subsequent reads from cache without refetching", async () => {
    apiFetchMock.mockResolvedValue({ a: "1" });
    await getSettings();
    const second = await getSettings();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(second.a).toBe("1");
  });

  it("refetches after invalidateSettings()", async () => {
    apiFetchMock.mockResolvedValueOnce({ a: "old" }).mockResolvedValueOnce({ a: "new" });
    expect((await getSettings()).a).toBe("old");
    invalidateSettings();
    expect((await getSettings()).a).toBe("new");
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ ok: "yes" });
    await expect(getSettings()).rejects.toThrow("boom");
    expect((await getSettings()).ok).toBe("yes");
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("expires the cache after the TTL safety net", async () => {
    vi.useFakeTimers();
    try {
      apiFetchMock.mockResolvedValueOnce({ a: "1" }).mockResolvedValueOnce({ a: "2" });
      await getSettings();
      vi.advanceTimersByTime(31_000);
      expect((await getSettings()).a).toBe("2");
      expect(apiFetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands each caller its own copy so the cache cannot be mutated", async () => {
    apiFetchMock.mockResolvedValue({ a: "1" });
    const first = await getSettings();
    first.a = "tampered";
    const second = await getSettings();
    expect(second.a).toBe("1");
  });

  it("does not let a pre-invalidation in-flight response repopulate the cache", async () => {
    let resolveFetch: (value: Record<string, string>) => void = () => {};
    apiFetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }))
      .mockResolvedValueOnce({ a: "fresh" });
    const stalePromise = getSettings();
    invalidateSettings();
    resolveFetch({ a: "stale" });
    expect((await stalePromise).a).toBe("stale");
    expect((await getSettings()).a).toBe("fresh");
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("setSettings PUTs the patch and invalidates the read cache", async () => {
    // Prime the cache with an initial read.
    apiFetchMock.mockResolvedValueOnce({ card_density: "comfortable" });
    expect((await getSettings()).card_density).toBe("comfortable");

    // The PUT, then the post-invalidation refetch sees the new value.
    apiFetchMock.mockResolvedValueOnce(undefined); // PUT
    apiFetchMock.mockResolvedValueOnce({ card_density: "compact" }); // refetch
    await setSettings({ card_density: "compact" });

    expect(apiFetchMock).toHaveBeenNthCalledWith(2, "/api/preferences/settings", {
      method: "PUT",
      body: JSON.stringify({ card_density: "compact" }),
    });
    // Cache was invalidated, so the next read hits the network (not the stale copy).
    expect((await getSettings()).card_density).toBe("compact");
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not invalidate the cache when the PUT rejects", async () => {
    apiFetchMock.mockResolvedValueOnce({ a: "cached" });
    await getSettings();
    apiFetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(setSettings({ a: "x" })).rejects.toThrow("network");
    // Still served from cache — no refetch triggered.
    expect((await getSettings()).a).toBe("cached");
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("setProjectPref scopes the key by project id", async () => {
    apiFetchMock.mockResolvedValue(undefined);
    await setProjectPref("p1", "start_mode", "monitor");
    expect(apiFetchMock).toHaveBeenCalledWith("/api/preferences/settings", {
      method: "PUT",
      body: JSON.stringify({ ["start_mode_p1"]: "monitor" }),
    });
  });
});
