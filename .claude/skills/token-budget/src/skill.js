'use strict';
/*
 * Skill-aware token analysis — models how an AGENT actually pays for a skill,
 * via progressive disclosure, instead of a flat per-file sum:
 *
 *   Tier 0  always-on   frontmatter name + description
 *                        → injected into the system prompt EVERY TURN of EVERY
 *                          session, for every registered skill. Premium real
 *                          estate: a token here is paid thousands of times.
 *   Tier 1  on-invoke    SKILL.md body (everything after the frontmatter)
 *                        → loaded once when the skill is triggered.
 *   Tier 2  on-demand    reference docs the agent reads ONLY when SKILL.md (or
 *                          another reachable doc) points at them.
 *   ----    not context  code/assets that are executed or ignored, never read
 *                          into the window; and unreferenced docs the agent has
 *                          no path to discover (dead weight).
 *
 * Reachability is transitive over doc files: start at SKILL.md's body, follow
 * mentions of in-skill paths, repeat. A doc nobody links to is flagged.
 */

const fs = require('fs');
const path = require('path');
const { walk, gitIgnored, toPosix, MAX_FILE_BYTES, TEXT_EXT } = require('./scan');

// read a file only if it's under the size cap; oversized (generated/minified)
// files return '' so they neither hang the tokenizer nor inflate counts
function readCapped(abs) {
  try {
    if (fs.statSync(abs).size > MAX_FILE_BYTES) return '';
    return fs.readFileSync(abs, 'utf8');
  } catch { return ''; }
}

const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst']);
// conventionally human/repo docs — not agent context, and not a problem when unlinked
const HUMAN_DOCS = new Set(['readme', 'license', 'licence', 'changelog', 'contributing', 'code_of_conduct', 'notice', 'authors', 'security']);
const isHumanDoc = (rel) => HUMAN_DOCS.has(path.basename(rel, path.extname(rel)).toLowerCase());

function findSkillMd(dir) {
  for (const e of fs.readdirSync(dir)) {
    if (e.toLowerCase() === 'skill.md') return path.join(dir, e);
  }
  return null;
}

// split a markdown file into { frontmatter, body, name, description }
function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: '', body: text, name: '', description: '' };
  const fm = m[1];
  const body = text.slice(m[0].length);
  const grab = (key) => {
    // single-line `key: value`, or folded/literal `key: >|` continued, indented
    const re = new RegExp(`^${key}:[ \\t]*(>-?|\\|-?)?[ \\t]*(.*)$`, 'm');
    const km = re.exec(fm);
    if (!km) return '';
    if (km[1]) {
      // block scalar: collect subsequent more-indented lines
      const after = fm.slice(km.index + km[0].length).split(/\r?\n/);
      const lines = [];
      for (const l of after) {
        if (/^\s+\S/.test(l) || l.trim() === '') lines.push(l.trim());
        else break;
      }
      return [km[2], ...lines].join(' ').trim();
    }
    return km[2].trim().replace(/^["']|["']$/g, '');
  };
  return { frontmatter: fm, body, name: grab('name'), description: grab('description') };
}

// which in-skill files does `text` mention? matched by relpath or distinctive basename
function mentions(text, relPaths) {
  const hits = new Set();
  for (const rel of relPaths) {
    const base = rel.split('/').pop();
    // relpath anywhere, or basename as a path-ish / backticked / linked token
    if (text.includes(rel)) { hits.add(rel); continue; }
    const re = new RegExp(`(^|[\\s/(\`"'])${base.replace(/[.+^${}()|[\]\\]/g, '\\$&')}([\\s)\`"':,.]|$)`, 'm');
    if (re.test(text)) hits.add(rel);
  }
  return hits;
}

function analyzeSkill(dir, counter) {
  const skillMd = findSkillMd(dir);
  if (!skillMd) throw new Error(`no SKILL.md found in ${dir}`);
  const skillRel = path.relative(dir, skillMd).split(path.sep).join('/');

  const raw = fs.readFileSync(skillMd, 'utf8');
  const { body, name, description } = parseFrontmatter(raw);

  // inventory every file in the skill (relative, posix), excluding SKILL.md itself
  // and anything the repo gitignores (working/generated files aren't skill content)
  const walked = [...walk(dir)];
  const ignored = gitIgnored(dir, walked);
  const all = walked
    .filter(f => !ignored.has(toPosix(f)))
    .map(f => path.relative(dir, f).split(path.sep).join('/'))
    .filter(r => r !== skillRel);
  const docs = all.filter(r => DOC_EXT.has(path.extname(r).toLowerCase()));

  // transitive reachability over doc files, seeded from SKILL.md body
  const reachable = new Set();
  let frontier = [{ rel: skillRel, text: body }];
  while (frontier.length) {
    const next = [];
    for (const { text } of frontier) {
      for (const rel of mentions(text, all)) {
        if (reachable.has(rel)) continue;
        reachable.add(rel);
        if (DOC_EXT.has(path.extname(rel).toLowerCase())) {
          const text = readCapped(path.join(dir, rel));
          if (text) next.push({ rel, text });
        }
      }
    }
    frontier = next;
  }

  const tok = (t) => counter.count(t);
  const read = (rel) => readCapped(path.join(dir, rel));
  // tokens only make sense for text; binaries/images are assets (don't tokenize —
  // it's meaningless and tokenizing big blobs is the main bottleneck)
  const isText = (rel) => { const e = path.extname(rel).toLowerCase(); return TEXT_EXT.has(e) || DOC_EXT.has(e); };
  const tokFile = (rel) => (isText(rel) ? tok(read(rel)) : 0);

  // Tier 0 — always-on. Approximate the harness injection: name + description.
  const alwaysOn = tok(`name: ${name}\ndescription: ${description}`);
  // Tier 1 — on invocation: SKILL.md body (frontmatter's name/desc already in Tier 0)
  const onInvoke = tok(body);

  // Tier 2 — on-demand referenced docs
  const onDemandDocs = docs
    .filter(r => reachable.has(r))
    .map(r => ({ path: r, tokens: tok(read(r)) }))
    .sort((a, b) => b.tokens - a.tokens);

  const entries = (list) => list.map(r => ({ path: r, tokens: tokFile(r) })).sort((a, b) => b.tokens - a.tokens);
  // Not context: code/assets are never read into the window (reachable or not);
  // human docs are conventional (README/LICENSE…); orphan docs are the real warning.
  const code = entries(all.filter(r => !DOC_EXT.has(path.extname(r).toLowerCase())));
  const unreachedDocs = docs.filter(r => !reachable.has(r));
  const humanDocs = entries(unreachedDocs.filter(isHumanDoc));
  const orphanDocs = entries(unreachedDocs.filter(r => !isHumanDoc(r)));

  const onDemandTotal = onDemandDocs.reduce((s, f) => s + f.tokens, 0);

  return {
    counter: counter.name,
    name, description,
    descriptionChars: description.length,
    tiers: {
      alwaysOn,                                   // Tier 0
      onInvoke,                                   // Tier 1
      onDemand: onDemandTotal,                    // Tier 2 (sum)
      onDemandDocs,                               // Tier 2 (per file)
    },
    // worst-case window if the skill is invoked AND every reachable doc is read
    fullyExpanded: alwaysOn + onInvoke + onDemandTotal,
    notContext: { code, humanDocs, orphanDocs },
  };
}

module.exports = { analyzeSkill, parseFrontmatter, findSkillMd, mentions, DOC_EXT };
