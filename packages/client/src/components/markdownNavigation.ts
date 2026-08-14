// ── Markdown navigation primitives (#452) ───────────────────────────
//
// A failing check quotes an exact identifier ("STORY-2-1 Sz.3 is recorded `auto` …") and the
// reviewer then has to find that row by eye in a 50-row table, inside a 60vh nested scroller
// where the browser's own Ctrl+F is close to useless. These pure functions are what the
// viewer needs to answer "where is that": an outline to jump by structure, and a find that
// reports the matching LINES so the raw view can highlight and scroll to them.
//
// Split out of PluginLoopExtras/ArtifactViewer so the artifact-viewer surfaces stay under the
// god-module ceiling (#465) — these are pure helpers with no React/API dependencies.

export type MarkdownHeading = { depth: number; text: string; line: number; slug: string };

/**
 * CRLF-safe line split. Artifacts are read off a Windows checkout, so a plain `split("\n")`
 * leaves a trailing `\r` on every line — which made every "blank" line a `"\r"` line that
 * `pre-wrap` renders as 0px, silently eating the file's paragraph structure in the raw view.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

const FENCE_RE = /^\s{0,3}(```|~~~)/;

/** Headings of a markdown document, with their 0-based line numbers. Fenced code is skipped
 *  so a `# comment` inside a shell block never becomes a fake outline entry. */
export function parseMarkdownOutline(content: string): MarkdownHeading[] {
  const out: MarkdownHeading[] = [];
  let inFence = false;
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    out.push({ depth: m[1].length, text, line: i, slug: slugifyHeading(text) });
  }
  return out;
}

/** 0-based indices of the lines containing `query` (case-insensitive, literal — the tokens
 *  a check quotes are identifiers like `STORY-2-1`, never regexes). */
export function findMatchingLines(content: string, query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: number[] = [];
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) hits.push(i);
  }
  return hits;
}

/** One line split into matched / unmatched runs, for `<mark>`ing without a regex. */
export function splitHighlight(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  const hay = text.toLowerCase();
  let at = 0;
  for (;;) {
    const idx = hay.indexOf(needle, at);
    if (idx === -1) break;
    if (idx > at) parts.push({ text: text.slice(at, idx), hit: false });
    parts.push({ text: text.slice(idx, idx + needle.length), hit: true });
    at = idx + needle.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts.length > 0 ? parts : [{ text, hit: false }];
}
