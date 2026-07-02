---
name: roast
description: Deliver a good-natured, affectionate roast of the board's current state — the Butler's /roast party trick.
---

The user invoked `/roast`. Deliver a short, good-natured roast of the board's
**current state** — a comedy bit grounded in the board's real data, not generic
jokes. Think loving jab from a friend who has watched this board for months, not a
takedown.

## 1. Gather the material (keep it to a couple of quick reads)
Pull just enough real board state to have something to riff on — do NOT fan out or
over-fetch:
- `get_board_status` — column counts and what's piling up (a fat Backlog, a
  clogged In Review, In Progress overload, an empty Done…).
- `list_issues` — titles, priorities, tags, and ages. Hunt for comedy gold: a
  ticket that's been open forever, a backlog no human will ever reach, a pile of
  "high priority" that clearly isn't, a graveyard of stale tags, ironic titles.
- Optionally one more signal if it's cheap: a workspace that's been "In Progress"
  suspiciously long, or a lonely column with zero cards.

Use the actual numbers and a real title or two — specificity is what makes a roast
land. If the board is genuinely tidy, roast it for being *suspiciously* tidy.

## 2. Write the roast
- **Good-natured and affectionate.** Punch up at the *process, the board, the
  backlog* — never at any person, and never at the quality of anyone's work in a
  hurtful way. Kind, not cruel. Keep it PG.
- **Short and punchy.** A quick setup line, then 3–5 zingers as bullets or tight
  one-liners. No wall of text, no long analysis — this is a bit, not a status report.
- **Grounded.** Every joke should reference something real you just read (a count, a
  title, an age, a suspicious pattern).
- **Land the plane.** Close with one genuinely warm, encouraging line so the user
  smiles instead of feeling judged.

Render it as scannable Markdown (a bold opener, then bullets). Then get back to being
the helpful butler.
