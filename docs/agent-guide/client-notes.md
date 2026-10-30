# Client package — notes (moved out of packages/client/CLAUDE.md, #1759)

Per-feature UI trivia kept out of the nested memory every client builder pays for on every turn.

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

