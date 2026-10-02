# UI Annotate (plugin)

This project has the **UI Annotate** plugin enabled. The user clicks through a web UI, marks
elements and comments on them; the notes are collected by a local collector (the "UI Annotate"
view shows its URL, the overlay snippet and the list).

When the user asks you to look at / discuss / act on their UI feedback:

- Read it with the plugin's `export` script (markdown) or `export --json`
  (`node tools/export.mjs [--json] [--all]`), or `GET <collector>/api/export`. Each item has the
  page URL, a CSS selector, the element text, the position and the user's comment.
- To wait for new feedback, long-poll `GET <collector>/api/poll?since=<seq>&timeout=25` (or
  `node tools/poll.mjs --since <seq>`); it returns as soon as something changes.
- Answer an item by `PATCH <collector>/api/annotations/<id>` with `{"reply": "..."}`; mark it
  done with `{"status": "resolved"}` only when the user agrees or the fix is merged.
- To turn feedback into a ticket, summarise `export` output into ONE `create_issue` (group by
  page/component); keep the selectors in the description. Do not create one ticket per note
  unless the user asks.

Never delete annotations on your own initiative.
