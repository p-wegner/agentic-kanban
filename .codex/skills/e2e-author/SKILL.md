---
name: e2e-author
description: Scaffold a Playwright E2E test for agentic-kanban that follows the project's anti-flake rules from day one
argument-hint: "[feature or flow to test]"
---

# e2e-author

Scaffold a new Playwright E2E test under `packages/e2e/tests/` for the feature in `$ARGUMENTS`.
The goal: produce a test that follows ALL of the project's hard-won anti-flake rules so it
never reintroduces the flakiness documented in CLAUDE.md.

## Where tests live
- UI tests: `packages/e2e/tests/ui/<name>.test.ts`
- API tests: `packages/e2e/tests/api/<name>.test.ts`
- Shared helpers: `packages/e2e/tests/helpers/`
  - `port.ts` exports `SERVER_URL`, `CLIENT_URL`, `SERVER_PORT`, `CLIENT_PORT` (all already on `127.0.0.1`).
  - `e2e-project.ts` exports `getE2EProject(request)` and `getE2EProjectId(request)`.

`playwright.config.ts` sets `baseURL` to `http://127.0.0.1:${clientPort}`, so `page.goto("/")`
already targets the right host/port. Always import `SERVER_URL` from `../helpers/port.js` for
API calls instead of building URLs yourself.

## RULES the new test MUST follow (non-negotiable)

1. **Host: `127.0.0.1`, never `localhost`.** Get it for free by importing `SERVER_URL`/`CLIENT_URL`
   from `../helpers/port.js` and by using `page.goto("/")` (baseURL handles the client).
2. **Ports: never hardcode 3001/5173.** They come from `port.ts`, which reads
   `process.env.SERVER_PORT` / `process.env.VITE_PORT`. Do not invent new port logic.
3. **Project ID: use `getE2EProjectId(request)`, never `projects[0]`.** `projects[0]` is the
   single biggest source of cross-run flakiness — the active project changes between runs.
4. **Scoped selectors, not bare `text=X`.** Prefer `page.locator("label", { hasText: "X" })`,
   `[aria-label=...]`, `[placeholder=...]`, `#id`, or a scoped parent locator. Use `.first()`
   only when you've confirmed the match is genuinely ambiguous and the first is the right one.
5. **Created titles get a `Date.now()` suffix** so runs don't collide:
   `const suffix = Date.now().toString(36);` then `` `My Issue ${suffix}` ``.
6. **`test.afterAll` cleanup is mandatory.** Track every created issue/workspace ID in an array
   and delete it. Reset any preference/setting the test mutated.
7. **Flaky setup / output fetching: retry loop (3 attempts, 500ms–1s), never `test.skip()`.**
   A `test.skip()` on setup failure silently hides lost coverage — log a clear error instead.
8. **No fixed sleeps for correctness.** Replace `page.waitForTimeout(N)` / `setTimeout(r, N)`
   with condition-based waits:
   - `await expect(locator).toBeVisible()` / `.toBeHidden()` (e.g. for backdrops/overlays)
   - `await page.waitForFunction(() => ...)` for DOM/state conditions
   - poll an API field (e.g. session `exit_code`) in a loop until it changes
   A tiny `waitForTimeout(300)` to let a debounced filter settle is tolerable, but never use a
   fixed sleep to wait for navigation, a session to finish, or an element to appear.

## Do NOT run `playwright install`
Browsers are pre-installed; `playwright.config.ts` auto-detects the headless-shell / chromium
binary path. Running install wastes time and can corrupt the lock file.

## Template

Base the new test on this skeleton (modeled on `tests/ui/search.test.ts` and
`tests/ui/session-history.test.ts`). Trim sections that don't apply.

```ts
import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("<FEATURE> UI", () => {
  let projectId: string;
  let statusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  // --- Retry helper: use for any setup/fetch that can be transiently flaky.
  async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * attempt)); // 500ms, 1s, 1.5s
      }
    }
    // Throw a clear error instead of silently test.skip()-ing.
    throw new Error(`[${label}] failed after 3 attempts: ${String(lastErr)}`);
  }

  test.beforeAll(async ({ request }) => {
    // RULE 3: resolve the isolated E2E project, never projects[0].
    projectId = await withRetry(() => getE2EProjectId(request), "getE2EProjectId");

    const statuses = await withRetry(async () => {
      const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
      if (!res.ok()) throw new Error(`statuses ${res.status()}`);
      return res.json();
    }, "fetch statuses");
    const todo = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todo ? todo.id : statuses[0].id;

    // RULE 5: unique suffix so created data never collides across runs.
    suffix = Date.now().toString(36);
  });

  test.afterAll(async ({ request }) => {
    // RULE 6: delete everything this file created; reset any mutated preference/setting.
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("<does the thing>", async ({ page, request }) => {
    // Arrange: create test data via API (faster + deterministic than UI clicks).
    const title = `<Feature> ${suffix}`;
    const issueId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title, statusId, projectId },
      });
      if (!res.ok()) throw new Error(`create issue ${res.status()}`);
      return (await res.json()).id;
    }, "create issue");
    createdIssueIds.push(issueId);

    // Act: drive the UI. baseURL already points at http://127.0.0.1:<clientPort>.
    await page.goto("/");
    await page.waitForSelector("h2"); // board loaded

    // RULE 4: scoped selectors, not bare text=.
    const card = page.locator("p", { hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();

    // RULE 8: condition-based waits, not fixed sleeps.
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    // Example: closing a backdrop overlay — wait for it to be hidden, don't sleep.
    // const backdrop = page.locator("div.fixed.inset-0.bg-black\\/30").first();
    // if (await backdrop.isVisible()) {
    //   await backdrop.click({ force: true });
    //   await expect(backdrop).toBeHidden();
    // }

    // Example: poll an API field instead of waitForTimeout (e.g. session completion).
    // await expect.poll(async () => {
    //   const r = await request.get(`${SERVER_URL}/api/workspaces/${wsId}/sessions`);
    //   const sessions = await r.json();
    //   return sessions[0]?.exit_code ?? null;
    // }, { timeout: 15000 }).toBe(0);

    // Assert
    await expect(/* ... */ card).toBeVisible();
  });
});
```

## Run just the new test
Use a worktree-aware command on `127.0.0.1` (ports are read from env automatically):

```bash
pnpm --filter @agentic-kanban/e2e exec playwright test tests/ui/<name>.test.ts
```

If the dev server isn't running, the `webServer` block in `playwright.config.ts` starts it
(`reuseExistingServer: true`). In a worktree, the server/client ports come from
`$env:KANBAN_SERVER_PORT` / `$env:KANBAN_CLIENT_PORT` via `scripts/dev.mjs` — never pass
hardcoded ports.

## Before finishing
- Re-read RULES 1–8 against the file you wrote; fix any violation.
- Confirm there's no `projects[0]`, no `localhost`, no hardcoded `3001`/`5173`, no `test.skip()`
  on setup failure, and no fixed sleep used for correctness.
