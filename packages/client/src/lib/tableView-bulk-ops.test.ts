import { describe, expect, it, vi } from "vitest";
import { bulkContractCoupled, type BulkOpDeps } from "./tableView-bulk-ops.js";

function createDeps(overrides: Partial<BulkOpDeps> = {}): BulkOpDeps {
  return {
    ids: ["issue-a", "issue-b"],
    api: vi.fn(async () => ({ memberIssueIds: ["issue-a", "issue-b"] })),
    toast: vi.fn(),
    setSelectedIds: vi.fn(),
    setBulkLoading: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
}

describe("bulkContractCoupled", () => {
  it("posts selected ids with the first selected issue as lead", async () => {
    const deps = createDeps();

    await bulkContractCoupled(deps);

    expect(deps.setBulkLoading).toHaveBeenNthCalledWith(1, true);
    expect(deps.api).toHaveBeenCalledWith("/api/issues/contract-coupled", {
      method: "POST",
      body: JSON.stringify({ issueIds: ["issue-a", "issue-b"], leadIssueId: "issue-a" }),
    });
    expect(deps.setSelectedIds).toHaveBeenCalledWith(new Set());
    expect(deps.toast).toHaveBeenCalledWith("Contracted 2 coupled issues", "success");
    expect(deps.onRefresh).toHaveBeenCalled();
    expect(deps.setBulkLoading).toHaveBeenLastCalledWith(false);
  });

  it("does nothing for a single selected issue", async () => {
    const deps = createDeps({ ids: ["issue-a"] });

    await bulkContractCoupled(deps);

    expect(deps.api).not.toHaveBeenCalled();
    expect(deps.setBulkLoading).not.toHaveBeenCalled();
  });
});
