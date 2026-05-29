# Talk Outline: From Vibe Coding to Agent Engineering

Working title (pick one):

- **"Past the Vibe: Engineering Around Agents"**
- **"I Built My AI Tool With My AI Tool — Twice. Here's What Changed."**
- **"Dogfooding Isn't Enough Anymore"**

Target length: 30–40 min talk + Q&A. Audience: working developers who have
already used Copilot/Cursor/Claude Code and are wondering what the next move is.

Companion docs in this folder:

- [`speedup-vs-traditional-team.md`](./speedup-vs-traditional-team.md) — numbers
- [`evolution-coding-aider-vs-agentic-kanban.md`](./evolution-coding-aider-vs-agentic-kanban.md) — 2024 vs 2026 side-by-side
- [`coding-aider-blog-article-gist.md`](./coding-aider-blog-article-gist.md) — the 2024 voice
- [`coding-aider-blog-article-raw.md`](./coding-aider-blog-article-raw.md) — original German source

## The arc in one sentence

> Vibe coding got us further than expected — but the next 10× isn't more vibes,
> it's putting **engineering discipline around the agent**: feedback signals,
> guardrails, concurrency, and a workflow that makes the human a reviewer
> instead of a typist.

## Why this talk now

Vibe coding and "build the thing with the thing" dogfooding stories are
everywhere in 2026. The novelty has worn off and developers are starting to
notice the gap between **demo speed** (impressive Twitter clip) and **sustained
speed** (shipping a real product across weeks). That gap is what this talk
addresses — not how to start with agents, but how to **not stall out** with them.

Most devs in the room will have:

- Shipped *something* with Copilot or Cursor or Claude Code
- Tried "vibe coding" and hit the wall around hour 10
- Watched an agent confidently destroy their working code at least once
- Heard the term "context engineering" without a clear next step

This talk is for them.

---

## Act 1 — Opener (5 min)

### Option A: The two repos

Open with two terminal windows side by side:

```
$ cd coding-aider     && git log --reverse --format=%ai | head -1
2024-09-04
$ cd agentic-kanban   && git log --reverse --format=%ai | head -1
2026-05-01

$ scc coding-aider/src   | tail -3   # 27k LOC, 14 months
$ scc agentic-kanban/src | tail -3   # 59k LOC, 28 days
```

Same builder. Same kind of project (dogfooded AI dev tool). Same level of
ambition. **~2× the code in ~7% of the calendar time.**

Pause. "What changed in the 14 months between them?"

Most of the room will guess: "the models got better." That's the bait.

The talk is about what *actually* changed — because if it were just the
models, the people in the room would already be seeing this gain.

### Option B: The honest moment

A short story, told without slides:

> Two years ago I shipped a JetBrains plugin called Coding-Aider. I wrote a
> blog post about it that I never published, because by the time I finished
> writing, half of what I said was already wrong. The tooling moved that fast.
>
> I sat on the article for a year. Last week I dug it out. And here's the
> thing: **the diagnosis still holds.** Everything I complained about in 2024
> — bad feedback loops, no progress tracking, fighting the model on style —
> is still the bottleneck. We just have better tools to *do something about it*
> now.
>
> So this talk is the article I should have published, updated with what I
> learned by building the thing that fixes the thing.

(Quote a line from the 2024 article in German to ground it as authentic, then
translate.)

### Pick: Option A for tech-heavy audiences, Option B for mixed/leadership.

### Positioning slide (either opener): The 5 Levels of AI Coding

Borrow Dan Shapiro's framing as a single orientation slide so the audience
knows where this talk lives:

```
Level 0: Spicy Autocomplete   → next-line suggestions (Copilot original)
Level 1: Coding Intern        → bounded tasks, human reviews every line
Level 2: Junior Developer     → multi-file edits, human still reads everything
Level 3: Developer as Manager → AI submits PRs, human reviews at feature level
Level 4: Developer as PM      → human writes spec, returns, checks outcomes
Level 5: Dark Factory         → spec in → product out, no human in the loop
```

> *"90% of developers who say they're AI-native operate at Level 2."*

This talk is about **what it actually takes to operate reliably at Level 3–4**
— without building skyscrapers that don't stand up.

---

## Act 2 — Diagnosis: why vibe coding stalls (8 min)

The point of this act: name the failure modes the audience has felt but hasn't
articulated. When they're nodding, you've earned the right to prescribe.

### 1. The demo-to-prod cliff

- Vibe coding is amazing for **hour 1**. By hour 10 the agent is confidently
  reintroducing bugs you fixed two prompts ago.
- Why: context drift, no automated feedback, chat history poisoning, no
  progress tracking. (Tie to the 2024 article's "biggest weakness of aider:
  no automatic progress tracking for complex tasks" — same problem, just
  bigger now.)
- **Data point worth quoting:** METR's 2025 RCT — 16 experienced OSS
  developers, 246 real tasks from their own repos. They *expected* +24%
  speedup with AI. Actual result: **−19% slower.** Self-assessment after the
  test: "felt about 20% faster."
  > *"This gap between perception and reality is striking."* — METR 2025
  
  Translation: the feeling of speed and the fact of speed are not the same
  thing, and most of us are bad at telling them apart without instrumentation.

### 2. The fundamental attribution error, applied to LLMs

> Borrow the article's framing: in social psychology, we underweight situation
> and overweight personality when judging people. We do the same to LLMs.

We blame "the model is dumb" when the real failure is **context starvation**
or **missing feedback**. This reframing is the wedge for everything that
follows: stop fixing the model, start fixing the environment around it.

### 3. The three feedback signals everyone already has and most don't wire up

1. **Compiler / type checker** — already runs, output is text, easy to feed back.
2. **Tests** — already exist, exit code says yes/no, easy to gate commits on.
3. **The running app** — Playwright / curl / log scraping. The agent can use
   the product the same way a user does.

These are not new ideas. They are the boring infrastructure that **separates
people getting 16× speedup from people getting 2× speedup.**

### 4. The Builder-vs-Mender tax

Most devs prefer writing code to reviewing code. Agents flip the ratio. If
you don't *want* to review, you'll fight the agent on every cosmetic choice
and burn the speedup discussing semicolons.

Concrete reframe: **distinguish rot from cosmetics.** SQL injection = stop the
world. `*ngIf` vs `@if` = let it go, fix it later in one prompt.

---

## Act 3 — The shift: what actually moved the needle (12 min)

Four concrete changes, each illustrated with a side-by-side of "2024 me" vs
"2026 me". The exact list (matches `evolution-coding-aider-vs-agentic-kanban.md`):

### 3.1 Concurrency: one chat → an agent fleet on a board

- 2024: one aider session, one feature at a time, my attention is the bottleneck.
- 2026: a kanban board with N worktrees, N agents, one human reviewing merges.
- **Demo (live or recorded):** the agentic-kanban board with 3–5 tickets
  actively in progress. "I'm not typing right now. I'm steering."

### 3.2 Self-verification: manual eyeballing → Playwright + visual-verify skill

- 2024: I run the plugin in a sandbox IntelliJ, click around, hope.
- 2026: the agent runs Playwright on its own changes, takes a screenshot, and
  decides whether to keep going. **The feedback loop closes without me in it.**
- Key insight: this is the difference between an agent that can *finish* and
  an agent that can only *start*.
- **Name the pattern** so the audience can take it home: the
  **Self-Verification Loop** (some call it the "Ralph Wiggum Loop" — keep
  trying until external checks say done):
  
  ```
  1. Agent attempts the task with current knowledge
  2. External verification: tests, linter, deterministic checks
  3. Adversarial review by a second agent with project rules in context
  4. Failed?  → retry (optionally update rules/context)
  5. Success? → human review at feature level
  6. Review feedback feeds back into the rules
  ```
  
  External verification is the load-bearing piece. Without it, the agent
  is just guessing whether it's done.

### 3.3 Guardrails: trust the agent → trust the harness around the agent

- Hooks block destructive DB ops. Hooks gate commits on test failure. Hooks
  refuse `--no-verify`.
- The agent is allowed to be dumb because the harness won't let dumb commits
  land. **This is what makes overnight runs survivable.**

### 3.4 Workflow as code: chat history → MCP tools + skills + tickets

- 2024: project knowledge lived in my head and in a long chat scrollback.
- 2026: project knowledge lives in `.claude/skills/`, `CLAUDE.md`, MCP tools.
- The agent has a **vocabulary**, not just a chat box. New agent on a new
  ticket starts with the same vocabulary the last one had.

### The unifying frame

These aren't four tricks. They're four corners of one idea: **you are not
prompting better, you are engineering a system that surrounds the agent.**

That system is the actual product. The features it ships are a byproduct.

---

## Act 4 — What this means for you (8 min)

The "so what" act. Practical and prescriptive — the audience should leave with
3 things they could do Monday morning.

### The honest caveat first: the J-curve

Before the prescription, name the cost openly. The 28-day / 59k LOC number is
not a starting point — it's the *output* of ~14 months of prior tooling
evolution (the Coding-Aider era), plus a non-trivial investment in the
harness around the agent (hooks, skills, MCP tools, E2E tests, the kanban
board itself).

> *"You're running a new engine on an old transmission."* — Dan Shapiro

Bolt agents onto an unchanged workflow and you get the **dip first**:
slower, more frustrating, more rework, the agent fights your conventions.
Teams that bail out at the dip conclude "AI doesn't work" — and they're
right, *for the setup they tried*. Teams that push through and rebuild the
workflow are the ones who report the 25–30%+ gains.

The honest version of the speedup claim: **the gain is real and it
compounds, but it's a J-curve, not a step change.** Plan for the dip.

### For individual developers

1. **Stop optimizing prompts. Start engineering context.** Get your test
   suite, type checker, and running app into the agent's loop.
2. **Pick a project you'll dogfood.** Not a toy, not a green field — something
   you'd build anyway. Dogfooding is the only way you'll notice what's missing
   in your setup. (The 2024 article's "pain-driven development" — still the
   right way in.)
3. **Move from Builder to reviewer.** Run multiple agents. The bottleneck
   stops being how fast you type and becomes how fast you can read a diff.

### For teams

1. **Invest in the harness, not the prompts.** Shared hooks, shared skills,
   shared MCP tools. The team's productivity is bounded by the worst feedback
   loop in the setup.
2. **Treat agent-runnable tests as a tier-1 artifact.** Not "we'll add them
   later". If the agent can't verify its own work, you become the verifier
   and the speedup collapses.
3. **Distinguish rot from cosmetics in code review.** Get explicit about what
   you'll fight on and what you'll let through. Otherwise the review queue
   eats the gain.

### For leadership / decision-makers (drop if dev-only audience)

1. The productivity gap between teams is widening. It's not about which model
   they pay for — it's about how much **engineering infrastructure** they've
   built around the model.
2. The compliance / IP question is still real and still slowing enterprises.
   The honest answer in 2026 is that the contractual-indemnity path
   (Copilot-style) buys safety but cedes the speedup. The on-prem path is
   getting close but isn't there yet for serious work.
3. Don't measure agent productivity in LOC. Measure it in **shipped tickets
   per reviewer-hour.** That metric reflects the new bottleneck.

---

## Act 5 — Close (3 min)

### Callback to the opener

> Same person. Same kind of project. ~7% of the calendar time. ~16× the
> code per active day.
>
> The model got better. But the model only accounts for a slice of it.
>
> The rest is **the boring stuff** — feedback loops, guardrails, concurrency,
> workflow as code. Software engineering, basically. Applied to the agent
> instead of to the code.

### The one line worth remembering

> **Vibe coding is what happens when the agent has no context, no feedback, and
> no guardrails. Engineering is what happens when it does.**

### Optional call to action

- Repo: agentic-kanban (point at GitHub URL once published)
- Article: the original 2024 piece, finally publishable as a "this is what I
  thought back then, here's what was right" companion post.

---

## Speaker notes / tone

- **Don't oversell.** The audience has been pitched too much. Concede that
  models still hallucinate, agents still loop, the harness is fragile.
  Credibility comes from naming the failure modes accurately.
- **Use exact numbers, not adjectives.** "28 days, 4,150 commits, 59k LOC"
  beats "incredibly fast". Numbers are why the talk lands.
- **One live demo max.** The agent fleet on the board is the strongest visual.
  Don't do a live coding demo — agent latency wrecks the pacing.
- **Lean into the year gap.** The 2024 article being authentic and slightly
  embarrassing is a feature. It makes the 2026 argument feel earned, not sold.

## Anti-patterns to avoid

- ❌ Spending Act 2 ranting about "vibe coders" — alienates half the room.
  Frame vibe coding as a useful starting point with a known ceiling.
- ❌ Showing a 30-second time-lapse of an agent doing something cool.
  Everyone has seen these. They've stopped working as proof.
- ❌ "AI won't replace developers" — true, but the audience has heard it
  500 times. Skip it or invert it: "AI won't replace developers, but
  developers who engineer their agent setup *will* outproduce those who don't."

## Open questions / things still to decide

- **One talk or two?** A "dev" version (this outline) and a leadership/
  Entscheider version that drops the demo and leans on the COCOMO/speedup
  numbers + compliance questions.
- **Live agent demo or pre-recorded?** Live is risky; pre-recorded with
  voiceover is safer and lets you control the pacing.
- **Where does the 2024 article appear?** Quoted on a slide, or published
  alongside the talk as a companion blog post? Strongest option: publish
  it the morning of the talk with a "here's the post I should have shipped
  two years ago" framing.
- **Demo recording assets:** need a clean board screenshot, an agent-fleet
  time-lapse, and a "guardrail in action" clip (e.g. hook blocking a
  destructive command).
