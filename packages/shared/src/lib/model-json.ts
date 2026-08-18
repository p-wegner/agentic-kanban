/**
 * ONE tolerant extractor for "the model printed JSON, possibly wrapped in prose or fences" (#550).
 *
 * There were six algorithms across thirteen sites, and the weakest of them was the most used:
 * strip a fence, then `JSON.parse` the whole thing. `extractJsonObject`'s own doc-comment in
 * `issue-ai.service.ts` explains why that is not enough — the small models "frequently
 * prefix/suffix the JSON with conversational text" — and yet four sites in that same file,
 * including one that names Haiku explicitly, used the fence-only path and threw on exactly the
 * failure the comment describes. Elsewhere a greedy `/\{[\s\S]*\}/` mis-parsed any reply
 * containing two objects (#355), and only `parsePluginLoopPlan` handled leading banners.
 *
 * The algorithm here is the strongest of the six generalised: strip fences, then find BALANCED
 * candidate values — tracking strings and escapes so a `}` inside a string cannot end one —
 * and parse them. So it survives leading banners, trailing prose, two objects in one reply, and
 * a fenced block with commentary around it.
 *
 * Deliberately NOT schema validation: this answers "which substring is the JSON", and callers
 * keep their own narrowing (#512's seam, #534).
 *
 * Pure — no node builtins, no drizzle — so the client may use it too.
 */

export type ModelJsonShape = "object" | "array" | "any";

export interface ExtractModelJsonOptions {
  /** Which opener to accept. Default "any". A caller expecting `{...}` should say so — it stops a stray array in the prose from winning. */
  shape?: ModelJsonShape;
  /**
   * Which candidate wins when the text holds several. Default "first", matching how the
   * majority of callers read a model reply ("here is the answer, then some chatter").
   * Use "last" when the noise comes BEFORE the value — a shell banner, an npm notice — which
   * is the plugin-loop planner's case.
   */
  prefer?: "first" | "last";
}

/** Thrown when no parseable JSON value of the requested shape is in the text. Carries the tail so the caller can report what the model actually said. */
export class ModelJsonError extends Error {
  /** The last ~400 characters of the offending output — enough to see the model's actual reply in a log or a 400. */
  readonly tail: string;

  constructor(message: string, tail: string) {
    super(message);
    this.name = "ModelJsonError";
    this.tail = tail;
  }
}

const OPENERS: Record<ModelJsonShape, string> = { object: "{", array: "[", any: "{[" };
const CLOSER: Record<string, string> = { "{": "}", "[": "]" };

/**
 * Index of the closer matching the opener at `start`, or -1 if the value never closes.
 * String-aware: a brace inside `"…"` does not change depth, and `\"` does not end the string.
 */
function findBalancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = CLOSER[open];
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Remove markdown code fences. A fence line never appears inside JSON, so this is safe to do
 * before scanning — and doing it first is what lets a fenced block surrounded by prose parse.
 */
function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?/g, "\n");
}

/**
 * Extract the JSON value a model meant to print.
 *
 * @throws ModelJsonError when nothing of the requested shape parses.
 */
export function extractModelJson(text: string, opts: ExtractModelJsonOptions = {}): unknown {
  const shape = opts.shape ?? "any";
  const prefer = opts.prefer ?? "first";
  const tail = (text ?? "").slice(-400);

  if (!text || !text.trim()) throw new ModelJsonError("empty model response", tail);

  const body = stripFences(text);
  const openers = OPENERS[shape];
  let found: unknown;
  let any = false;

  for (let i = 0; i < body.length; i++) {
    if (!openers.includes(body[i])) continue;
    const end = findBalancedEnd(body, i);
    if (end === -1) continue;
    let value: unknown;
    try {
      value = JSON.parse(body.slice(i, end + 1));
    } catch {
      // Balanced but not valid JSON (prose in braces, a JS object literal) — keep scanning.
      continue;
    }
    found = value;
    any = true;
    if (prefer === "first") return found;
    // "last" wins: skip past this value so a nested one cannot outrank its parent.
    i = end;
  }

  if (!any) {
    const what = shape === "any" ? "JSON value" : `JSON ${shape}`;
    throw new ModelJsonError(`no ${what} found in model response`, tail);
  }
  return found;
}
