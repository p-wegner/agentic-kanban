# UI Annotate

Click through a web UI, mark elements, comment on them, and collect the notes as a structured
ticket — or let an agent read them live. Not tied to the board: any web app can use it.

## How it works

1. The plugin's **UI Annotate** view runs a small local *collector* (zero-dependency Node, binds
   `127.0.0.1`).
2. A page loads the collector's **overlay** — either `<script src="http://127.0.0.1:<port>/overlay.js">`
   or the dashboard's bookmarklet (works on any page, including the board's own UI).
3. In **Annotate** mode, hover highlights an element and a click opens a comment box. The note stores
   the page URL, a CSS selector, the element text, its position/viewport and your comment. Browse mode
   (default) leaves the page fully usable. Existing notes show as numbered pins.
4. Consumers read the notes through the collector — nothing is tied to Butler:

| Consumer | How |
|---|---|
| Agent terminal | long-poll `GET /api/poll?since=<seq>&timeout=25`, or `node tools/poll.mjs --since <seq>` |
| Ticket | `GET /api/export` (markdown) / dashboard **Copy as ticket markdown** / `node tools/export.mjs` |
| Butler | the plugin's prompt fragment tells it to use the above |
| Reply / resolve | `PATCH /api/annotations/:id` `{reply, status}` |

## Other web apps

Pair it with the **App Runner** plugin: start the app there, add the overlay script tag (or use the
bookmarklet), annotate. `data-session="name"` on the script tag separates annotation sets.

## Notes

- State is in `~/.agentic-kanban/ui-annotate/<project key>.json`, never in the repo.
- The collector allows cross-origin requests (the overlay runs on other origins) but listens on loopback
  only. Any page open in your browser can reach it; do not annotate pages with secrets in their text.
- A page with a strict CSP may block the script tag/bookmarklet.
- Offline check: `node tools/selftest.mjs`.
