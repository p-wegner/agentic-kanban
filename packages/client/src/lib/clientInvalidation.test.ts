import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import {
  clearAvailableIssuesCache,
  getCachedAvailableIssues,
  invalidateClientSurface,
  invalidateClientSurfaceLocal,
  setCachedAvailableIssues,
  subscribeClientInvalidations,
} from "./clientInvalidation.js";
import { invalidateBundle } from "./issueDetailBundleCache.js";
import { invalidateSettings } from "./settingsStore.js";

vi.mock("./issueDetailBundleCache.js", () => ({ invalidateBundle: vi.fn() }));
vi.mock("./settingsStore.js", () => ({ invalidateSettings: vi.fn() }));

function fakeQueryClient(): QueryClient {
  return {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  } as unknown as QueryClient;
}

describe("clientInvalidation", () => {
  beforeEach(() => {
    clearAvailableIssuesCache();
    vi.clearAllMocks();
  });

  it("invalidates workspace queries, local issue caches, and publishes an event", async () => {
    const queryClient = fakeQueryClient();
    const listener = vi.fn();
    const unsubscribe = subscribeClientInvalidations(listener);
    setCachedAvailableIssues("project-1", [{ id: "issue-1" }]);

    await invalidateClientSurface(queryClient, {
      surface: "workspace",
      projectId: "project-1",
      issueId: "issue-1",
    });

    expect(getCachedAvailableIssues("project-1")).toBeNull();
    expect(invalidateBundle).toHaveBeenCalledWith("issue-1");
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects", "project-1", "board"],
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects", "project-1", "workspaces", "issue-1"],
    });
    expect(listener).toHaveBeenCalledWith({
      surface: "workspace",
      projectId: "project-1",
      issueId: "issue-1",
    });

    unsubscribe();
  });

  it("keeps local-only invalidation usable for non-React Query caches", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeClientInvalidations(listener);

    invalidateClientSurfaceLocal({ surface: "settings" });

    expect(invalidateSettings).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ surface: "settings" });

    unsubscribe();
  });
});
