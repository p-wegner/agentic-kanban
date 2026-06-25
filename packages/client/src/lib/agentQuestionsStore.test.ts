import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingQuestionSet } from "../components/AgentQuestionsPanel.js";

// apiFetch is the single network seam — mock it and count calls to prove the
// react-query-backed store dedupes concurrent callers and serves within the TTL.
const apiFetch = vi.fn();
vi.mock("./api.js", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { queryClient } from "./queryClient.js";
import { getAgentQuestions, invalidateAgentQuestions } from "./agentQuestionsStore.js";

const PROJECT = "project-1";

function makeQuestions(n: number): PendingQuestionSet[] {
  return Array.from({ length: n }, (_, i) => ({
    toolUseId: `tu-${i}`,
    workspaceId: `ws-${i}`,
    sessionId: `s-${i}`,
    issueId: `iss-${i}`,
    issueNumber: i,
    issueTitle: `Issue ${i}`,
    questions: [],
    askedAt: null,
  }));
}

describe("agentQuestionsStore (react-query backed)", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    queryClient.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dedupes concurrent callers into one in-flight request", async () => {
    apiFetch.mockResolvedValue({ questions: makeQuestions(2) });

    const [a, b, c] = await Promise.all([
      getAgentQuestions(PROJECT),
      getAgentQuestions(PROJECT),
      getAgentQuestions(PROJECT),
    ]);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(a).toHaveLength(2);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("serves cached data within the TTL without re-fetching", async () => {
    apiFetch.mockResolvedValue({ questions: makeQuestions(1) });

    await getAgentQuestions(PROJECT);
    await getAgentQuestions(PROJECT);

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("force re-fetches even when fresh", async () => {
    apiFetch.mockResolvedValue({ questions: makeQuestions(1) });

    await getAgentQuestions(PROJECT);
    await getAgentQuestions(PROJECT, { force: true });

    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("invalidate forces the next read to hit the network", async () => {
    apiFetch.mockResolvedValue({ questions: makeQuestions(1) });

    await getAgentQuestions(PROJECT);
    invalidateAgentQuestions(PROJECT);
    await getAgentQuestions(PROJECT);

    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("invalidate() with no project clears agent-questions across projects", async () => {
    apiFetch.mockResolvedValue({ questions: makeQuestions(1) });

    await getAgentQuestions("p1");
    await getAgentQuestions("p2");
    expect(apiFetch).toHaveBeenCalledTimes(2);

    invalidateAgentQuestions();

    await getAgentQuestions("p1");
    await getAgentQuestions("p2");
    expect(apiFetch).toHaveBeenCalledTimes(4);
  });

  it("scopes the cache per project", async () => {
    apiFetch.mockResolvedValue({ questions: makeQuestions(1) });

    await getAgentQuestions("p1");
    await getAgentQuestions("p2");

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenNthCalledWith(1, "/api/projects/p1/agent-questions");
    expect(apiFetch).toHaveBeenNthCalledWith(2, "/api/projects/p2/agent-questions");
  });
});
