/**
 * Global E2E teardown — deletes any test-artifact issues that leaked into the active project.
 *
 * E2E tests track their created issues in `afterAll` hooks, but if a test crashes or times out
 * those hooks may not run. This teardown provides a safety net by identifying and removing
 * issues whose titles match known test-generated patterns.
 *
 * Patterns covered:
 *  - "Session stats test ..."
 *  - "Task progress test ..."
 *  - "board-stats-..." (board-stats-bar.test.ts)
 *  - "RT create test ..." / "RT status test ..." (board-realtime.test.ts)
 *  - "⏰ e2e-..." (scheduled-run system issues whose parent run was deleted without cleanup)
 *  - Any title starting with "e2e-" followed by a random slug
 */

import { request } from "@playwright/test";

const serverPort = Number(process.env.SERVER_PORT) || 3001;

/** Patterns that identify E2E-generated test artifact issues. */
const TEST_TITLE_PATTERNS: RegExp[] = [
  /^Session stats test /,
  /^Task progress test /,
  /^board-stats-/,
  /^RT (create|status) test /,
  /^⏰ e2e-/,
  /^e2e-[a-z]+-[0-9a-z]+$/i,
];

function isTestArtifact(title: string): boolean {
  return TEST_TITLE_PATTERNS.some((re) => re.test(title));
}

async function globalTeardown() {
  const apiContext = await request.newContext({
    baseURL: `http://localhost:${serverPort}`,
  });

  try {
    // Get the active project
    const prefRes = await apiContext.get("/api/preferences/active-project");
    if (!prefRes.ok()) return;
    const { projectId } = await prefRes.json();
    if (!projectId) return;

    // Fetch all issues for the active project
    const issuesRes = await apiContext.get(
      `/api/issues?projectId=${projectId}`,
    );
    if (!issuesRes.ok()) return;
    const issues: Array<{ id: string; title: string }> = await issuesRes.json();

    // Also clean up any orphaned scheduled runs whose name matches e2e patterns
    const runsRes = await apiContext.get(
      `/api/scheduled-runs?projectId=${projectId}`,
    );
    if (runsRes.ok()) {
      const runs: Array<{ id: string; name: string }> = await runsRes.json();
      for (const run of runs) {
        if (/^e2e-/i.test(run.name)) {
          await apiContext.delete(`/api/scheduled-runs/${run.id}`);
        }
      }
    }

    // Delete leaked test issues
    const leaked = issues.filter((i) => isTestArtifact(i.title));
    if (leaked.length > 0) {
      console.log(
        `[global-teardown] Cleaning up ${leaked.length} leaked test issue(s):`,
        leaked.map((i) => `"${i.title}"`).join(", "),
      );
      for (const issue of leaked) {
        await apiContext.delete(`/api/issues/${issue.id}`);
      }
    }
  } catch (err) {
    // Non-fatal — teardown errors must not fail the test run
    console.warn("[global-teardown] Cleanup error (non-fatal):", err);
  } finally {
    await apiContext.dispose();
  }
}

export default globalTeardown;
