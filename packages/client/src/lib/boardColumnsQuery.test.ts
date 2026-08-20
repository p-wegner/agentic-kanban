import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { boardQueryKeys } from "./boardQueryKeys.js";
import {
  __resetBoardEtags,
  boardColumnsQueryOptions,
  clearBoardEtag,
  fetchBoardColumns,
} from "./boardColumnsQuery.js";

function issue(id: string, over: Partial<IssueWithStatus> = {}): IssueWithStatus {
  return {
    id,
    issueNumber: Number(id.replace(/\D/g, "")) || 1,
    title: `Issue ${id}`,
    statusId: "s1",
    statusName: "Todo",
    issueType: "task",
    ...over,
  } as IssueWithStatus;
}

function col(name: string, issues: IssueWithStatus[]): StatusWithIssues {
  return { id: name, name, position: 0, issues } as StatusWithIssues;
}

const PID = "project-1";

/** Minimal fetch Response stub. */
function res(status: number, body: unknown, etag?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === "etag" ? etag ?? null : null) },
    json: async () => body,
  } as unknown as Response;
}

describe("fetchBoardColumns — the single ETag-aware board transport (react-query owned)", () => {
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = new QueryClient();
    __resetBoardEtags();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("first load: full GET (no If-None-Match), returns columns and stores the ETag", async () => {
    fetchMock.mockResolvedValueOnce(res(200, [col("Todo", [issue("1")])], 'W/"v1"'));

    const cols = await fetchBoardColumns(PID, queryClient);

    expect(cols[0].issues[0].id).toBe("1");
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers ?? {})["If-None-Match"]).toBeUndefined();
  });

  it("sends If-None-Match once an ETag is known and prior columns exist", async () => {
    queryClient.setQueryData(boardQueryKeys.board(PID), [col("Todo", [issue("1")])]);
    // Seed the ETag via a 200.
    fetchMock.mockResolvedValueOnce(res(200, [col("Todo", [issue("1")])], 'W/"v1"'));
    await fetchBoardColumns(PID, queryClient);
    queryClient.setQueryData(boardQueryKeys.board(PID), await Promise.resolve([col("Todo", [issue("1")])]));

    fetchMock.mockResolvedValueOnce(res(304, null));
    await fetchBoardColumns(PID, queryClient);

    const [, init] = fetchMock.mock.calls[1];
    expect((init?.headers ?? {})["If-None-Match"]).toBe('W/"v1"');
  });

  it("304 returns the previously cached columns (no reconcile effect needed)", async () => {
    const prev = [col("Todo", [issue("1")])];
    queryClient.setQueryData(boardQueryKeys.board(PID), prev);
    // Prime the ETag.
    fetchMock.mockResolvedValueOnce(res(200, prev, 'W/"v1"'));
    await fetchBoardColumns(PID, queryClient);

    fetchMock.mockResolvedValueOnce(res(304, null));
    const cols = await fetchBoardColumns(PID, queryClient);

    expect(cols).toBe(prev);
  });

  it("WS invalidation: a 200 with new data yields fresh columns without any reconcile effect", async () => {
    // Initial load committed to the cache via the full query path.
    fetchMock.mockResolvedValueOnce(res(200, [col("Todo", [issue("1")])], 'W/"v1"'));
    await queryClient.fetchQuery(boardColumnsQueryOptions(PID, queryClient));
    expect(queryClient.getQueryData<StatusWithIssues[]>(boardQueryKeys.board(PID))![0].issues).toHaveLength(1);

    // A board_changed WS event triggers a refetch; server returns a new board.
    fetchMock.mockResolvedValueOnce(res(200, [col("Todo", [issue("1"), issue("2")])], 'W/"v2"'));
    const fresh = await queryClient.fetchQuery({
      ...boardColumnsQueryOptions(PID, queryClient),
      staleTime: 0,
    });

    // The single owner (the query cache) now holds the fresh columns — no
    // separate mirror to reconcile.
    expect(fresh[0].issues.map((i) => i.id)).toEqual(["1", "2"]);
    expect(queryClient.getQueryData<StatusWithIssues[]>(boardQueryKeys.board(PID))![0].issues).toHaveLength(2);
  });

  it("reuses unchanged issue references against the cached prior board (memo-friendly)", async () => {
    const prevIssue = issue("1", { title: "Same" });
    queryClient.setQueryData(boardQueryKeys.board(PID), [col("Todo", [prevIssue])]);

    fetchMock.mockResolvedValueOnce(res(200, [col("Todo", [issue("1", { title: "Same" })])], 'W/"v1"'));
    const cols = await fetchBoardColumns(PID, queryClient);

    expect(cols[0].issues[0]).toBe(prevIssue);
  });

  it("clearBoardEtag forces the next fetch to be unconditional", async () => {
    queryClient.setQueryData(boardQueryKeys.board(PID), [col("Todo", [issue("1")])]);
    fetchMock.mockResolvedValueOnce(res(200, [col("Todo", [issue("1")])], 'W/"v1"'));
    await fetchBoardColumns(PID, queryClient);

    clearBoardEtag(PID);
    fetchMock.mockResolvedValueOnce(res(200, [col("Todo", [issue("1")])], 'W/"v2"'));
    await fetchBoardColumns(PID, queryClient);

    const [, init] = fetchMock.mock.calls[1];
    expect((init?.headers ?? {})["If-None-Match"]).toBeUndefined();
  });

  it("throws a useful error on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(res(500, { error: "boom" }));
    await expect(fetchBoardColumns(PID, queryClient)).rejects.toThrow("boom");
  });
});
