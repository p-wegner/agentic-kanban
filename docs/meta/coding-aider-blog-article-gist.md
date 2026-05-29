# Gist: "KI-gestützte Softwareentwicklung — Vom Hype zur Realität"

Unpublished blog article by Peter Wegner (2024/early-2025 era), written during
the build of the **Coding-Aider** JetBrains plugin. Summarized in English for
re-use in talks. Raw German source: [`coding-aider-blog-article-raw.md`](./coding-aider-blog-article-raw.md).

Companion to [`evolution-coding-aider-vs-agentic-kanban.md`](./evolution-coding-aider-vs-agentic-kanban.md) —
this is the contemporaneous "voice from inside the moment" that the evolution
comparison looks back on.

## TL;DR

The hype around AI-assisted coding is overblown *in either direction*. Current
LLMs make unpredictable mistakes and fail on non-trivial work without careful
context. But the gap between "I use ChatGPT and Copilot" and "I use the best
available agentic tooling" is much bigger than most developers realize — and
worth closing, today, not in five years.

The article makes the case via building Coding-Aider: a JetBrains plugin
wrapping the `aider` CLI, written largely *with* aider itself.

## Core arguments

### 1. Models need feedback — humans take theirs for granted

We're surrounded by implicit and explicit feedback signals all the time. We
underestimate this and then expect LLMs to perform without comparable signals.
Wegner ties this to the **fundamental attribution error**: with people, we
underweight situation/context and overweight disposition. We do the same with
LLMs — blaming the model for what's actually a context-starvation problem.

The community noticed: **"Prompt engineering" → "context engineering"**. The
question isn't only "how do I phrase this", but "what knowledge, tools, and
memory does my system have access to?"

### 2. Compilers, runtime, tests = first-class context

Three things developers already have that should be wired into the loop:

- Compiler / IDE errors → extremely useful context.
- Console output and stack traces → extremely useful context.
- Tests at multiple abstraction levels → extremely useful context, especially
  when they fail.

These are the obvious feedback signals, and most 2024-era AI tooling didn't
plumb them properly. (This is the same point that the agentic-kanban project
later operationalizes as Playwright E2E + hooks blocking commits on test
failure.)

### 3. JetBrains-side tooling was visibly behind VSCode

In 2024 the heat was on Cursor / Windsurf / Cline / CLI tools, all VSCode- or
terminal-flavored. JetBrains plugins lagged badly:

- Continue: 2.8/5
- GitHub CoPilot for JetBrains: 2.6/5
- JetBrains AI Assistant: 2.0/5

Concrete gaps Wegner felt:

- Multi-file edits via chat without copy-paste
- Context selection for inline edits
- Avoiding "rest of the code remains as before" placeholder responses
- Mitigating knowledge-cutoff for new libraries
- Feedback loops for compile errors and failing tests

### 4. Aider as a model of "good enough"

Aider got several things right:

- **Repo-map** giving the model an overview of the project
- **Manual context selection** by the developer (treated as a feature, not bug)
- **Auto git commit per change**
- **Automatic diff weaving** into existing files (cheaper tokens, fewer errors)
- **Recovery loops** for un-applicable patches and lint failures
- **Model-agnostic** — local or cloud, with rapid support for new models
- Largely self-hosted: aider is written with aider, by one developer, with
  benchmarks cited by DeepSeek and used in academic work like Sakana's
  AI-Scientist

Aider's weakness: **no automatic progress tracking for complex multi-step
tasks**. Chat history helps but also creates failure-mode loops; sometimes you
need a fresh context, not more history.

### 5. The build story — "pain-driven development"

The Coding-Aider plugin started with a single prompt:

> create an action in the project view context menu that will open a dialog
> with a text field that will be used as the message argument for a cli
> application named aider

With `build.gradle` in context, the model knew enough about the project type
to also flag that `plugin.xml` needed updating — early hints of agentic
behavior. Subsequent features grew out of friction:

- Docker support (Windows aider setup was painful)
- Prompt history + redo button + autocompletion (typing was tedious)
- **Structured mode**: model writes a plan + checklist as markdown files, then
  works through the checklist across many turns. This was the most useful
  feature he built, and is now standard in 2026 tools (Amazon Kiro's
  spec-driven dev, etc.)
- Markdown output viewer + auto-opening git diff after each commit
  (visibility of AI changes)

The meta-point: **the plugin was its own best test case**. Dogfooding tightens
the feedback loop on the tool itself.

### 6. Local models aren't there yet (mid-2025)

`qwen2.5-coder:32b` is impressive for its size and competes with OpenAI in
benchmarks, but in practice local models can't drive aider on real projects
the way Claude/GPT-class models can. This matters because the compliance /
data-protection story is the main blocker for enterprise adoption — and
local-only would solve it.

GitHub Copilot's contractual indemnity for generated code is, for now, the
"safe enterprise choice" even when the tool itself is mediocre.

### 7. Closing argument: rethink habits, not just tools

The biggest mindset shift:

- Most developers prefer writing code to reviewing AI-generated code (Builder
  vs. Mender mentality). AI coding requires more Mender.
- Not every line of code needs to be the way *you* would have written it.
  Software is a means to an end; perfection on style is often waste.
- **Distinguish "cosmetic flaws" from "rot"** in AI-generated code. SQL
  injection or data-loss bugs = stop. Stale-style choices (no primary
  constructors in C#, `*ngIf` vs `@if` in Angular) = fixable later by another
  prompt.
- Good system prompts + `agents.md`-style rule files reduce style mismatches
  by leveraging LLMs' tendency to follow existing patterns.

> "Wenn die penible Korrektur und Diskussion von Schönheitsfehlern wesentlich
> mehr Zeit in Anspruch nimmt als die eigentliche Implementierung, dann
> verpufft der Vorteil von GenAI für die Softwareentwicklung."

Roughly: *if nitpicking AI output takes more time than the implementation
itself, the productivity gain evaporates.*

The goal isn't to replace developers. It's to give sovereign developers a
sharper tool — one that respects their quality bar without becoming a
discussion partner about every semicolon.

## Why this gist matters for the talk arc

This article is the **2024 voice** of the same builder who later built
agentic-kanban. Reading it next to the 2026 evolution doc, several things land:

1. **The diagnosis was right.** Feedback loops, context engineering, plan +
   checklist mode — all called out in 2024, all now table stakes in 2026.
2. **The execution was constrained by the tooling of the moment.** No
   self-verification, no agent fleet, no MCP, no skills, no kanban — just
   aider + a JetBrains plugin + manual context selection. Even so: ~23k LOC
   of working Kotlin plugin, mostly written by the tool.
3. **The wishlist became the next product.** Many of "what's missing"
   complaints in the article are exactly what agentic-kanban operationalizes:
   automatic progress tracking across complex tasks, multi-file editing
   without copy-paste, compile/test feedback as first-class context, plan +
   checklist mode as a default workflow.
4. **The cultural argument hasn't changed.** Builder-vs-Mender, distinguish
   rot from cosmetics, don't fight the model on style — these are still the
   hard part. The tool got better; the human adaptation is still the
   bottleneck.

A talk that opens with the 2024 diagnosis and ends with the 2026 numbers
("same person, same dogfooding pattern, ~2× the code in ~7% of the calendar
time") writes itself.
