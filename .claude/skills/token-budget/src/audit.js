'use strict';
/*
 * Lightweight static "bloat" finder for prose/markdown — surfaces likely
 * token waste so a human/agent can decide what to cut. Heuristic, never
 * auto-edits. The real reduction guidance lives in
 * references/optimization-guide.md; this just points at candidates.
 */

const FILLER = [
  /\b(?:in order to)\b/gi,            // -> "to"
  /\b(?:it (?:is|should be) (?:important|worth) (?:to note|noting) that)\b/gi,
  /\b(?:please note that|note that)\b/gi,
  /\b(?:as (?:you can see|mentioned (?:above|earlier|before)))\b/gi,
  /\b(?:basically|essentially|simply|just|actually|really|very|quite)\b/gi,
  /\b(?:there (?:is|are) (?:a (?:number|lot) of|several))\b/gi,
];

function lines(text) { return text.split(/\r?\n/); }

function audit(text, counter) {
  const findings = [];
  const ls = lines(text);

  // 1) filler phrases
  let fillerHits = 0;
  for (const re of FILLER) {
    const m = text.match(re);
    if (m) fillerHits += m.length;
  }
  if (fillerHits) findings.push({ kind: 'filler', count: fillerHits, hint: 'hedging/filler phrases — cut or tighten (see optimization-guide.md §filler)' });

  // 2) duplicate lines (exact, non-trivial)
  const seen = new Map();
  let dupTokens = 0;
  for (const l of ls) {
    const t = l.trim();
    if (t.length < 20) continue;
    if (seen.has(t)) dupTokens += counter.count(t);
    else seen.set(t, true);
  }
  if (dupTokens) findings.push({ kind: 'duplicate-lines', tokens: dupTokens, hint: 'repeated lines — dedupe or reference once' });

  // 3) very long lines / walls of text (hard to skim, often restating)
  const longParas = ls.filter(l => l.length > 400).length;
  if (longParas) findings.push({ kind: 'long-paragraphs', count: longParas, hint: 'paragraphs >400 chars — split, bullet, or trim restating' });

  // 4) heavy heading-to-content ratio could mean over-structuring (informational)
  const headings = ls.filter(l => /^#{1,6}\s/.test(l)).length;
  if (headings) findings.push({ kind: 'headings', count: headings, hint: 'section count (informational — many tiny sections add scaffolding tokens)' });

  return { total: counter.count(text), findings };
}

module.exports = { audit, FILLER };
