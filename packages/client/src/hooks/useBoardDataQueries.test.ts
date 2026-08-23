import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, keepPreviousData } from "@tanstack/react-query";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { boardQueryKeys } from "../lib/boardQueryKeys.js";
import { __resetBoardEtags } from "../lib/boardColumnsQuery.js";
import { boardQueryConfig } from "./useBoardDataQueries.js";

function issue(id: string): IssueWithStatus {
  return {
    id,
    issueNumber: Number(id.replace(/\D/g, "")) || 1,
    title: `Issue ${id}`,
    statusId: "s1",
    statusName: "Todo",
    issueType: "task",
  } as IssueWithStatus;
}

function col(name: string, issues: IssueWithStatus[]): StatusWithIssues {
  // `position` is not a field of `StatusWithIssues` (it is `sortOrder`), and `projectId`/
  // `count` were missing — the cast hid a fixture that had drifted from the DTO.
  return { id: name, name, projectId: "project-1", sortOrder: 0, issues, count: issues.length };
}

/** Minimal fetch Response stub. */
function res(status: number, body: unknown, etag?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === "etag" ? etag ?? null : null) },
    json: async () => body,
  } as unknown as Response;
}

const PID = "project-1";

/**
 * G11 regression: the MOUNTED board query (useBoardQuery) must run through the
 * ETag-aware transport in boardColumnsQuery.ts. A bare apiFetch queryFn on the
 * same key silently replaces the transport (last-applied queryFn wins), so
 * every mount/reconnect skipped the If-None-Match/304 path.
 */
describe("boardQueryConfig — the config useBoardQuery mounts with", () => {
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

  it("uses the board query key and keepPreviousData for project switches", () => {
    const config = boardQueryConfig(PID, queryClient);
    expect(config.queryKey).toEqual(boardQueryKeys.board(PID));
    expect(config.enabled).toBe(true);
    expect(config.placeholderData).toBe(keepPreviousData);
  });

  it("is disabled without a projectId", () => {
    const config = boardQueryConfig(null, queryClient);
    expect(config.enabled).toBe(false);
  });

  it("queryFn goes through the ETag transport: a repeat fetch sends If-None-Match and a 304 reuses cached columns", async () => {
    const config = boardQueryConfig(PID, queryClient);

    // First mount: full GET, ETag stored, columns committed to the cache.
    const board = [col("Todo", [issue("1")])];
    fetchMock.mockResolvedValueOnce(res(200, board, 'W/"v1"'));
    const first = await queryClient.fetchQuery(config);
    expect(first[0].issues.map((i) => i.id)).toEqual(["1"]);

    // Remount/reconnect: the SAME query fn must send If-None-Match and fall
    // back to the cached columns on 304 (bare apiFetch would neither).
    fetchMock.mockResolvedValueOnce(res(304, null));
    const second = await queryClient.fetchQuery({ ...config, staleTime: 0 });

    const [, init] = fetchMock.mock.calls[1];
    expect(((init?.headers ?? {}) as Record<string, string>)["If-None-Match"]).toBe('W/"v1"');
    expect(second).toBe(first);
  });
});
