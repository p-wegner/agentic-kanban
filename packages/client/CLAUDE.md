# Client Package — Architecture Patterns

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

## Workspace panel status guards
Don't gate session history, TerminalView, and session stats on `ws.status !== "closed"` — auto-merged workspaces set `workingDir: null` and `status: "closed"` but their history is still viewable. Only chat footer and action buttons (Review, Merge, etc.) should be gated on active status.
