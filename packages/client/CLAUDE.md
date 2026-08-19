# Client Package — Architecture Patterns

## `View` means a BOARD VIEW — a container's pure half is `*Body` (#611)

`view` is the client's most overloaded noun: 27 board views in `VIEW_REGISTRY` (guarded by
the `viewTabs` collision test) against the presentational halves of container/presentation
pairs, which also ended in `View`. Reading `FleetServiceStackMapView` you could not tell
whether it was a registered board view or half a component.

**Board view = `VIEW_REGISTRY` entry. A container's pure half = `*Body`.** Renamed:
`RepoMergeStatusStripView` → `…Body`, `FleetServiceStackMapView` → `…Body`,
`MultirepoHealthPillView` → `…Body`.

Only those three — the container pairs #611 names. The other `*View` components in
`components/` were left alone deliberately: renaming 32 symbols is churn with a real chance
of collateral damage, and the rule above is what stops the ambiguity growing. Rename the
rest opportunistically when you are already in the file.

## Two client patterns that were consistent but unnamed (#589)

### `lib/<feature>.ts` — the pure core beside a component or hook

The client's testable logic already lives this way: a pure view-model in `lib/`, paired with
the component or hook that renders it — `crossRepoImpact.ts` ↔ `CrossRepoImpactHeatmap.tsx`,
`mergeReadiness.ts` ↔ `MergeReadinessBoard.tsx`, `boardRouteSync.ts` ↔ `useBoardPageRoute.ts`,
`ticketTrailCore.ts` ↔ `useTicketTrail.ts`. The split is visible in the test ratio: 85 test
files for 125 `lib/` files, against 43 for 244 components.

**Rule: a pure module belongs in `lib/`, whatever renders it.** `components/` is `.tsx`;
`hooks/` is `use*`. A pure `.ts` in either is a stray, and five had accumulated
(`gateCardPolicy`, `markdownNavigation`, `repoEditPayload`, `workflowHistory`,
`hooks/ticketTrailCore`) — all now in `lib/` with their tests. `components/boardLazyViews.ts`
is the one deliberate exception: it is lazy-import WIRING for components, not logic, and it
names them.

### `lib/<entity>Query.ts` — the query-options module

`xQueryOptions(id) → { queryKey, queryFn, staleTime }` plus `fetchX` and
`invalidateX(queryClient)`, with keys in `boardQueryKeys.ts`: `boardColumnsQuery.ts`,
`projectReposQuery.ts`, `workspacesListQuery.ts`, `workspaceRepoStatusQuery.ts`.

This is the endorsed TARGET of the client data-fetching ring (#513) — the ~40 hand-rolled
`data/loading/error/cancelled/retryKey` ladders migrate here. Naming it is what makes
"migrate to react-query" a concrete instruction rather than a direction.

### And the DTOs they consume: `lib/<feature>Types.ts` (#610)

`projectTypes.ts`, `issueDetailTypes.ts`, `boardTypes.ts`, `settingsTypes.ts`. A type-only
import is erased at compile time, so a hook importing its own return type UP from the
component that renders it never fails — which is how `routes/BoardPage.tsx` became the
board's DTO module, `Tag` ended up declared five times, and `WorkspaceInitial` twice with a
real disagreement about whether `sessionId` was optional. Declare the DTO in `lib/`; the
component may re-export it.

## tsconfig excludes test files
`tsconfig.json` uses `"include": ["src"]` which picks up `*.test.ts` files. Always include `"exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]` — otherwise `tsc -b` fails because vitest isn't a declared type dep for production builds.

## `/` key search shortcut
`e.preventDefault()` on keydown doesn't prevent the subsequent input event from inserting the character. Fix: use `requestAnimationFrame` to clear the stray `/` after focus shift.

## Board refresh during create form
WebSocket `board_changed` events can unmount inline create form mid-edit. Skip board refreshes while `creatingInColumnId` is set; queue pending refresh via ref; process when form closes.

## Panel state sync
`selectedIssue` in BoardPage is a snapshot captured on click. A `useEffect` watches `columns` changes and re-finds the issue by ID, updating `selectedIssue` in place. If deleted, the panel closes.

## Panel stays open after save
Don't call `setSelectedIssue(null)` from `handleUpdateIssue` — the useEffect above re-syncs data. Add `onIssueUpdate` prop if the panel needs to push updates upstream.

## Unsaved changes guard
Use a `hasChanges` derived boolean (compare local edit state against `issue` prop) and `window.confirm()` in backdrop click, close button, Escape, and Cancel handlers.

## Search result highlighting
Pass `searchQuery` through `BoardColumn` → `IssueCard`. The `HighlightedText` component splits text at first match and wraps in `<mark>`. Only highlights first occurrence.

## Slide-in animations
Defined in `app.css` as `@keyframes slide-in-right` with `transform: translateX(100%) → 0`. Applied via `animate-slide-in-right`. 0.2s ease-out.

## Collapsible column groups
Board splits columns into active (Todo, In Progress, In Review) and archive (Done, Cancelled) based on `ARCHIVE_STATUS_NAMES` set (name-based). Archive renders as collapsed bar; click to expand. E2E: scope "Cancel" locators carefully — collapsed bar "Cancelled" matches `button:has-text("Cancel")`. Use `form.locator(...)` or regex `/^Cancel$/`.

## Command palette
Actions registered via `registerAction()` in `actions.ts`. BoardPage registers in `useEffect` with cleanup. Ctrl+K intercepted via `window` keydown listener (Playwright can't send Ctrl+K — Chromium intercepts for address bar). E2E tests dispatch via `page.evaluate(() => window.dispatchEvent(...))`.

## SplitButton pattern
Use `<SplitButton>` (`src/components/SplitButton.tsx`) whenever an action has one clear default and one or more less-frequent variants. The primary action sits on the left; a chevron on the right opens a dropdown with the variants.

```tsx
<SplitButton
  primary={{ label: "Review", onClick: () => doReview(false) }}
  options={[{ label: "Thorough Review", onClick: () => doReview(true) }]}
  disabled={loading}
  colorClasses="bg-violet-600 hover:bg-violet-700 border-violet-500"
  dropUp={false}   // set true when button is near the bottom of the viewport
/>
```

**Current usages:** none at present — the component is available as a sanctioned primitive but no view wires it today (the former Review/Thorough Review usage was superseded). `WorkspacePanel`'s "New Workspace" quick-launch uses an equivalent inline pattern (not migrated because it has complex inline state logic). Reach for `SplitButton` when adding a new default+variants action rather than hand-rolling a dropdown.

**When to apply:** Two separate buttons that do "the same thing but differently" (intensity, model, mode flag) should become one SplitButton. Unrelated actions stay as separate buttons.

## Swimlane / side-by-side lane layouts
When building grid-like layouts with a sticky label column (lane header) and scrollable data columns (cells row), the **outer lane row must have `display: flex`** (e.g. `className="flex ..."`). Without it, the header and cells stack vertically even if inner containers look correct. The bug appears as: lane label renders above all columns instead of beside them.

## Locale-explicit formatting
Always pass `'en-US'` (or another explicit locale) to `toLocaleDateString()`, `toLocaleString()`, and `toLocaleTimeString()`. Omitting the locale (or passing `undefined`) falls back to the OS/browser locale — on a de-DE machine this produces German output (`Mai`, `4.079`) in an otherwise English UI. This is especially easy to miss in charting components and metrics views.

## Workspace panel status guards
Don't gate session history, TerminalView, and session stats on `ws.status !== "closed"` — auto-merged workspaces set `workingDir: null` and `status: "closed"` but their history is still viewable. Only chat footer and action buttons (Review, Merge, etc.) should be gated on active status.

## SSE from POST endpoints
Server-sent events consumed from POST endpoints (e.g. merge-queue execution) **must** use `fetch()` + `ReadableStream`, not `EventSource`. `EventSource` only supports GET. Pattern:
```ts
const resp = await fetch(url, { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } });
const reader = resp.body!.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // parse SSE lines from decoder.decode(value)
}
```

## URL scheme (#446) — the URL is derived state, never written ad hoc
`/p/<project-slug>/<view>[/<tab>][/issue/<n>[/workspace]]`. A raw project id works anywhere a slug does, so an id link never rots; slugs come from `lib/projectSlug.ts` and every colliding name is disambiguated (never just the newcomer, or an existing project's URL would silently change).

- **Parse/build only through `lib/appRoutes.ts`** (`parseAppPath`/`buildAppPath`). `parsed.tab` is RESOLVED — a container view always reports a tab, its default when the path names none — so use `tabIsExplicit` when you need "did the path actually say this".
- **Components do not write the URL.** They change state (project, view, tab, selected issue); `routes/boardRouteSync.ts` decides the path and whether it is a push or a replace, and `useBoardPageRoute` performs it. Writing `history.pushState` from a component is how the two disagree.
- **One logical navigation = one history entry.** Call `markProgrammaticNavigation()` before a multi-step deep link (project → view → issue); the burst makes the first write push and the rest replace.
- **In-place upgrades are replaces**: a legacy flat path gaining its project scope, an absorbed view's old path (`/burndown` → `/p/<slug>/analytics/burndown`), a raw-id path canonicalised to the slug. None is a navigation.
- **Anything read from the URL must be honoured BEFORE the sync effect runs.** The container view mounts ~100ms after the sync canonicalises the path, so a value only readable inside the container has already lost — that is why the legacy `?tab=` is promoted into the path at router init (`planLegacyTabParamUpgrade`), not read by `useViewTab`.
- `lib/viewTabs.ts` (`VIEW_TAB_REGISTRY`) is the single source of tab ids and defaults for both the router and the container components. `issue`/`issues`/`workspace` are reserved segments — a tab id may not collide with them (asserted by a test).
