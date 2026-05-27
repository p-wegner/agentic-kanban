# Learning: Butler UI + streaming — four traps that look like bugs but aren't (and one that was)

**Date:** 2026-05-28
**Severity:** Medium — none crashed anything, but each cost real debugging time and two produced confidently-wrong output to the user.
**Short version:** While polishing the Butler chat (model/profile pickers, stop button, markdown, board guidance) I hit four issues that each *looked* like data corruption or a framework bug but had a precise, reusable explanation: a React-StrictMode dup, a Tailwind-v4 typography gap, an SDK token-accounting trap, and a PowerShell display artifact. Plus one genuine CSS bug. Documented so the next person (or agent) doesn't re-investigate.

---

## 1. Duplicate streaming bubbles = impure `setState` updater under StrictMode

**Symptom:** every assistant turn rendered **twice** — a short orphan bubble + the full one (4 bubbles for 2 turns).

**Cause:** `appendAssistantText` mutated a ref *inside* the `setChatMessages` updater:

```tsx
setChatMessages((prev) => {
  if (last?.id === assistantMsgIdRef.current) { ...append... }
  const id = `asst-${...}`;
  assistantMsgIdRef.current = id;   // ❌ side effect inside an updater
  return [...prev, { id, ... }];
});
```

React **StrictMode (dev only) double-invokes state updaters** to surface impurity. The first invocation set the ref to id `X`; the replay didn't match the (still-old) `last` and created a second bubble with id `Y`. Net: one orphan + the growing bubble.

**Fix:** decide the id *outside* the updater so the updater is pure:

```tsx
if (!assistantMsgIdRef.current) assistantMsgIdRef.current = `asst-${...}`;
const id = assistantMsgIdRef.current;
setChatMessages((prev) => last?.id === id ? replace : append);
```

**Rule:** never mutate refs / fire side effects inside a `setState` updater. It's invisible in prod (StrictMode is dev-only) but corrupts state in dev — easy to misread as a streaming/SSE bug.

## 2. Markdown renders unstyled, then inline code shows literal backticks (Tailwind v4 + typography)

Two-part trap when rendering butler markdown with `prose`:

1. **`prose` did nothing** (borderless tables, bullet-less lists, headings == body text) because `@tailwindcss/typography` wasn't installed. Tailwind **v4 has no `tailwind.config.js`** — enable plugins in CSS: `@plugin "@tailwindcss/typography";` in `app.css`. Without the plugin, `prose` classes are no-ops and the preflight reset strips list/table styling.
2. Once enabled, inline code rendered as `` `like this` `` — the plugin injects **literal backtick pseudo-elements** (`code::before/::after { content: "\`" }`) and gives code no background. Override in `.prose`: set `::before/::after { content: none }` and add a pill background. Confirm with `getComputedStyle(el,'::before').content` — the element's `textContent` is clean; the backticks are pseudo-content.

## 3. "Context usage = 400k from one question" — don't sum a turn's usage counts

The usage chip ballooned absurdly (≈400k for a ~30k context). The metric summed `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens` from the result event. **`cache_read_input_tokens` re-counts the whole context on every tool round-trip within a turn**, so a multi-tool turn inflates the sum far past the real window — that's tokens *billed*, not context *occupancy*.

**Fix:** use the SDK's own accounting — `query.getContextUsage()` → `totalTokens` / `maxTokens`. That's the same number Claude Code's `/context` shows (~29k baseline here). The breakdown also proved skills load as *frontmatter only* (~3k for 44 skills), i.e. the agent already behaves like a standard Claude Code instance — no skill preloading to "fix".

## 4. PowerShell "mojibake" is a display artifact, not data corruption

`Invoke-RestMethod` output showed `ð´`/`â` instead of 🔴/—. **PowerShell 5.1 mangles UTF-8 on display.** The stored bytes were clean — verified by fetching the same data with Node (`fetch().json()`), which showed intact `🔴`/`—`. Before "fixing" an encoding bug, confirm the actual bytes with a UTF-8-correct tool (Node, or `Get-Content -Encoding utf8`); don't trust the PS console rendering. (Distinct from the *real* mojibake-on-write pitfall in `[[pitfall_bom_encoding]]`, which corrupts files — this one corrupts only the terminal view.)

## 5. (Real bug) `<textarea>` is `inline-block` → baseline gap misaligns a sibling button

The send/stop button sat ~6px below the input. The input row was `items-end`, but a `<textarea>` defaults to `display:inline-block`, so its wrapper reserved descender space below it (wrapper 48px, textarea 42px). `items-end` aligned the button to the *wrapper* bottom, not the textarea's. **Fix:** add `block` to the textarea so the wrapper hugs it. General rule: when bottom-aligning a control next to a `<textarea>`/`<input>`, make the field `block` (or `align-bottom`) to kill the inline baseline gap.

---

## Takeaways

- Dev-only weirdness (double renders) → suspect **StrictMode + an impure updater** before SSE/network.
- Tailwind **v4** plugins live in CSS (`@plugin`), and `@tailwindcss/typography` needs inline-code `::before/::after` overridden.
- For "context used", trust **`getContextUsage()`**, never a hand-rolled token sum.
- Treat PowerShell console glyphs as **untrusted**; verify bytes with UTF-8-correct tooling.
- `inline-block` form controls add a baseline gap — `block` them when aligning siblings.
