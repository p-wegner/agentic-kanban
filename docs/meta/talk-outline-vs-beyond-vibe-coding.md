# Comparison: New Talk Outline vs. "Beyond Vibe Coding"

Side-by-side review of the talk outline drafted in this repo
([`talk-outline.md`](./talk-outline.md)) against the existing **Beyond Vibe
Coding** talk at `C:/andrena/beyond_vibe_coding/presentation/talk_outline.md`.

Both target working developers in the post-vibe-coding moment; both argue that
engineering discipline around agents is the real lever. They overlap heavily
in *thesis* but differ substantially in *texture, evidence base, and entry point*.

## At a glance

| Dimension                | Beyond Vibe Coding (BVC)                                  | New outline (NTO)                                         |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------- |
| Length                   | 45 min                                                     | 30–40 min                                                  |
| Title direction          | "Was Software Engineering braucht, wenn niemand mehr Code schreibt" | "Past the Vibe: Engineering Around Agents" / variants |
| Opening device           | **CAD-1982 analogy** (architect at drawing board vs. CAD) | **Two-repo side-by-side** (Coding-Aider 2024 vs agentic-kanban 2026) OR "unpublished article" story |
| Structure                | High-level → Practical (demo) → High-level (vision)       | Opener → Diagnosis → The Shift → So What → Close          |
| Core organizing frame    | **3 Pillars** (Explicit Expectations / Persistent Feedback / Agent Orchestration) | **4 Changes** (Concurrency / Self-Verification / Guardrails / Workflow as Code) |
| Evidence base            | Research-heavy (METR RCT, GitClear, DORA, ArXiv Cursor study, Dan Shapiro 5 Levels, Boris Cherny/Dario quotes) | Personal numbers (~28 days, ~4150 commits, ~59k LOC) + 2024 article as period-authentic voice |
| Live demo                | Quality Expectation Loop with hooks + Angular catalog      | Recommends a *single* demo (agent fleet on kanban board), warns against live coding |
| Mindset frame            | Builder vs. Mender, "Stop fixing AI's mistakes, start building the system" | "Engineering is what happens when the agent has context, feedback, and guardrails" |
| Adjacent frameworks cited | SpecKit, BMAD, GSD, OpenSpec, Claude Code Plan Mode      | (largely doesn't name external frameworks)                |
| Closing one-liner        | "Wer wird die Systeme bauen, die AI brauchbar machen?"     | "Vibe coding is what happens when the agent has no context, no feedback, and no guardrails. Engineering is what happens when it does." |
| Languages targeted       | German (with English quotes)                               | English-drafted, language-agnostic                         |

## Where they agree (the shared thesis)

Both talks land the same core argument, just from different angles:

1. **Vibe coding has a ceiling.** The hour-1 demo magic doesn't scale to
   week-10 product work.
2. **Models aren't the bottleneck — the system around them is.** Both reframe
   "the model is dumb" as a context/feedback/harness problem.
3. **The new role is reviewer / system-builder, not typist.** Both explicitly
   call out the Builder-vs-Mender flip.
4. **Distinguish rot from cosmetics.** Both name this exact phrase pattern —
   SQL injection / security = stop; stylistic drift = let it go and fix later
   with a prompt.
5. **Feedback signals already exist.** Compiler/tests/runtime are the
   infrastructure most teams haven't wired up. Both talks make this point.
6. **Persistence matters.** Both push CLAUDE.md / agents.md / skills as the
   way to convert one-off corrections into compounding rules.
7. **Plans/specs become more valuable when execution gets cheap.** BVC quotes
   "80% planning + reviewing, 20% working"; NTO frames the same as "workflow
   as code".

## Where they diverge (the useful contrast)

### Entry point: pedagogical vs. personal

- **BVC** opens with the **CAD-1982 analogy** — a strong, vivid, abstract
  hook that works for any audience and any moment in tooling history. It's
  the equivalent of "I'm going to teach you to see this differently."
- **NTO** opens with **two terminal windows** showing the same builder at two
  points in time, then "what changed?" — a personal, concrete, numbers-first
  hook. It's the equivalent of "I'm going to show you what I learned by
  doing it."

**Both are strong; they're different rhetorical moves.** BVC earns abstract
reframing rights; NTO earns "trust me, I've walked the path" rights.

### Evidence base: external research vs. internal artifact

- **BVC** leans heavily on third-party studies: METR (-19% with AI vs +24%
  expected), GitClear (8× duplication), DORA (+98% PRs, unchanged delivery),
  ArXiv Cursor (+41% complexity). This is **defensive credibility** — useful
  for skeptical audiences and decision-makers who want sources.
- **NTO** leans on first-party numbers from two repos in the same hand. This
  is **offensive credibility** — "I'm not citing research, I'm showing you
  the receipts."

**Combined, they're stronger than either alone.** External research + lived
numbers cover both "is this real in general" and "is this real for one
practitioner".

### Framework: 3 Pillars vs. 4 Changes

- **BVC's 3 Pillars** (Explicit Expectations / Persistent Feedback / Agent
  Orchestration) is a **prescriptive** frame — here's what to build.
- **NTO's 4 Changes** (Concurrency / Self-Verification / Guardrails /
  Workflow as Code) is a **diagnostic** frame — here's what shifted between
  era A and era B.

These overlap substantially:

| BVC pillar                | NTO change                                  | Notes                                                |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| Explicit Expectations     | Workflow as Code                             | Both = make project knowledge legible to the agent  |
| Persistent Feedback       | Self-Verification + Guardrails              | NTO splits the loop in two (close it + protect it)  |
| Agent Orchestration       | Concurrency                                  | Direct overlap                                       |

NTO's **Guardrails** axis (hooks blocking bad commits) is slightly more
prominent than in BVC, where it's folded into "Persistent Feedback".

BVC's **Explicit Expectations** axis (specs, agents.md, pattern files) gets
heavier treatment than NTO's "Workflow as Code", with a full landscape
comparison (SpecKit/BMAD/GSD/OpenSpec).

### Demo strategy: in-talk vs. caution

- **BVC** has a substantial live demo (8 min) of the Quality Expectation Loop:
  Claude Code + CLAUDE.md + hooks + git worktree. Shows the loop closing in
  real time.
- **NTO** explicitly *warns against* live coding demos ("agent latency wrecks
  pacing") and recommends one pre-recorded clip showing the agent fleet on
  the board.

**These reflect different appetites for risk and different demo material.**
BVC's demo is tightly scoped (one rule, one hook) and survivable live. NTO's
"demo" would be a board with N concurrent agents — harder to fit in 5–8 min
live, easier as a 30-second time-lapse.

### Mindset frames

Both talks end at the same destination but take different roads:

- BVC's central reframe: *"Stop fixing AI's mistakes. Start building the
  system where those mistakes don't happen."* (action-oriented)
- NTO's central reframe: *"Vibe coding is what happens when the agent has no
  context, no feedback, and no guardrails. Engineering is what happens when
  it does."* (definitional)

BVC's framing is the **call to action**; NTO's is the **definition that
justifies the call**.

## What the new outline can borrow from BVC

These are concrete additions that would sharpen NTO without diluting its
narrative:

1. **The CAD-1982 analogy** as an alternative opener (or an Act-2 reframe).
   It's the strongest abstract anchor either talk has.
2. **The 5 Levels of AI Coding** (Dan Shapiro). Useful framing for
   positioning the audience: "most of you are on Level 2; this talk is about
   how to operate reliably on Level 3–4."
3. **The research citations** (METR, GitClear, DORA, ArXiv Cursor). Even
   one or two would beef up the diagnosis act with external credibility,
   especially the METR finding that perceived-speedup ≠ actual-speedup.
4. **The Ralph Wiggum / Self-Verification Loop** as a named pattern.
   NTO talks about self-verification abstractly; BVC names the loop steps
   1–7. Names make ideas portable.
5. **The Boris Cherny / Dario Amodei quotes** about Anthropic's
   self-coding percentages. These are now industry-standard reference points.
6. **The "agent-native checklist"** ("if a developer can do X, the agent
   should too") — concrete, immediately actionable.
7. **The "J-curve" honesty** — admitting that adopting this workflow has a
   productivity dip before the gain. NTO is currently too triumphant about
   the numbers and could use this honesty.

## What BVC could borrow from the new outline

In return:

1. **The personal evolution arc** (2024 article + 2024 plugin + 2026 board).
   BVC is currently a synthesis talk; adding the personal arc would give it
   an authenticity layer it doesn't have. The unpublished blog article
   "found in a drawer" is a strong rhetorical device.
2. **First-party throughput numbers**. Saying "I shipped 59k LOC in 28 days
   solo" hits differently than citing GitClear. (Use both.)
3. **The "agent fleet on a kanban board" demo concept** as a stronger visual
   than the single-agent Quality Expectation Loop. Concurrency is the most
   visible 2026-era shift.
4. **The closing definition** ("Vibe coding is X; Engineering is Y") is
   sharper than BVC's "Wer baut die Systeme?" — could be incorporated as a
   slide quote.

## Are these one talk or two?

There are three plausible paths:

### Path A — Treat NTO as the dev-focused update to BVC

NTO becomes a focused 30-min version: less research, more lived experience,
sharper hooks. BVC remains the comprehensive 45-min version for audiences
that need the full prescription + research base.

Use NTO at: meetups, podcasts, internal company talks, conference lightning
slots.
Use BVC at: full conference slots, leadership audiences, training contexts.

### Path B — Merge into one "definitive" 45-min talk

Take BVC's structure and inject:

- The two-repo opener (replacing or pairing with CAD)
- The personal evolution arc as a thread through Act 2
- The first-party numbers as a callback throughout
- The sharper closing definition

Keep BVC's research citations, 5 Levels frame, 3 Pillars, and demo.

This is the most ambitious — and probably the highest-impact talk. But it
risks losing focus.

### Path C — Two distinct talks for two distinct moments

- **BVC stays as the "what should you do?" talk** — pedagogical, prescriptive,
  framework-heavy. Best after an audience asks "okay, I'm convinced, what
  now?"
- **NTO becomes the "is this real?" talk** — narrative, numbers, two-repo
  proof. Best for an audience that's still skeptical or hype-fatigued.

You'd pick which to give based on the room.

**Recommendation:** Path C, with Path B as the long-term aspiration. Path A
underuses NTO's distinctive material.

## Concrete edits to NTO based on this comparison

If you keep NTO as a standalone talk, the comparison suggests:

1. **Add the J-curve honesty in Act 2.** The 28-day / 59k LOC number is
   triumphant; balance it with "this required ~14 months of prior tooling
   evolution and the harness investment is non-trivial."
2. **Add 1–2 research citations in Act 2.** METR's "perceived vs. actual"
   finding is the cheapest credibility boost.
3. **Name the self-verification loop.** "Ralph Wiggum Loop" or a fresh name —
   making it a named pattern makes it teachable.
4. **Consider adding the 5 Levels frame** as a single slide before Act 3, to
   position where "engineering around agents" lives in the spectrum.
5. **Keep the two-repo opener.** It's NTO's strongest distinctive asset and
   shouldn't be diluted.
