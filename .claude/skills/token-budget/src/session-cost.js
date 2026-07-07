'use strict';
/*
 * Reconstruct cost + token usage from a Claude Code SESSION TRANSCRIPT — the
 * route for runs that weren't captured with `claude -p --output-format json`
 * (interactive sessions, or after the fact). Also gives a per-SUBAGENT
 * breakdown the envelope can't (the envelope only splits by model).
 *
 * Layout under ~/.claude/projects/<encoded-cwd>/:
 *   <session_id>.jsonl                     — main transcript
 *   <session_id>/subagents/agent-*.jsonl   — one per Task subagent (isSidechain)
 *   <session_id>/subagents/agent-*.meta.json — { agentType, description, ... }
 *
 * Each assistant message carries a real `usage` block. Summing per-message
 * usage is correct for cost (each record is that turn's actually-billed
 * tokens), as long as each token category is priced at its own rate — which
 * pricing.costForUsage does. Dollar figures here are ESTIMATES from a local
 * price table; the envelope's costUSD is authoritative when you have it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { costForUsage } = require('./pricing');

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Resolve a session id / transcript path / session dir to { transcript, dir }.
function locate(target) {
  if (fs.existsSync(target)) {
    const st = fs.statSync(target);
    if (st.isFile()) {
      const dir = target.replace(/\.jsonl$/i, '');
      return { transcript: target, dir: fs.existsSync(dir) ? dir : null };
    }
    if (st.isDirectory()) {
      // a <session_id> dir — transcript is the sibling <session_id>.jsonl
      const t = `${target}.jsonl`;
      return { transcript: fs.existsSync(t) ? t : null, dir: target };
    }
  }
  // treat as a session id: search every project dir
  const root = projectsRoot();
  if (!fs.existsSync(root)) throw new Error(`no transcript found for "${target}" (and ${root} missing)`);
  for (const proj of fs.readdirSync(root)) {
    const t = path.join(root, proj, `${target}.jsonl`);
    if (fs.existsSync(t)) {
      const dir = path.join(root, proj, target);
      return { transcript: t, dir: fs.existsSync(dir) ? dir : null };
    }
  }
  throw new Error(`no transcript found for session id "${target}" under ${root}`);
}

function* readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try { yield JSON.parse(l); } catch (_) { /* skip partial/corrupt lines */ }
  }
}

// Aggregate assistant-message usage from one jsonl file, per model.
function aggregateFile(file) {
  const byModel = {};
  let messages = 0;
  for (const e of readJsonl(file)) {
    if (e.type !== 'assistant') continue;
    const msg = e.message || {};
    const u = msg.usage;
    if (!u || msg.role !== 'assistant') continue;
    const model = msg.model || 'unknown';
    const m = byModel[model] || (byModel[model] = {
      model, messages: 0,
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      costUSD: 0, costKnown: true,
    });
    m.messages++;
    messages++;
    m.input_tokens += u.input_tokens || 0;
    m.output_tokens += u.output_tokens || 0;
    m.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    m.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    const c = costForUsage(model, u);
    if (c == null) m.costKnown = false; else m.costUSD += c;
  }
  return { models: Object.values(byModel), messages };
}

function readMeta(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/i, '.meta.json');
  if (!fs.existsSync(metaPath)) return {};
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { return {}; }
}

// Full reconstruction: main transcript + every subagent transcript.
function analyzeSession(target) {
  const { transcript, dir } = locate(target);
  if (!transcript) throw new Error(`found session dir but no transcript .jsonl for "${target}"`);

  const main = aggregateFile(transcript);
  const subagents = [];
  const subDir = dir && path.join(dir, 'subagents');
  if (subDir && fs.existsSync(subDir)) {
    for (const f of fs.readdirSync(subDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(subDir, f);
      const meta = readMeta(full);
      const agg = aggregateFile(full);
      subagents.push({
        file: f,
        agentType: meta.agentType || null,
        description: meta.description || null,
        spawnDepth: meta.spawnDepth != null ? meta.spawnDepth : null,
        ...agg,
      });
    }
  }

  // Totals across main + subagents, per model and grand.
  const perModel = {};
  const add = (models) => {
    for (const m of models) {
      const t = perModel[m.model] || (perModel[m.model] = {
        model: m.model, messages: 0,
        input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        costUSD: 0, costKnown: true,
      });
      t.messages += m.messages;
      t.input_tokens += m.input_tokens;
      t.output_tokens += m.output_tokens;
      t.cache_read_input_tokens += m.cache_read_input_tokens;
      t.cache_creation_input_tokens += m.cache_creation_input_tokens;
      if (!m.costKnown) t.costKnown = false;
      t.costUSD += m.costUSD;
    }
  };
  add(main.models);
  for (const s of subagents) add(s.models);

  const models = Object.values(perModel).sort((a, b) => b.costUSD - a.costUSD);
  const grand = models.reduce((g, m) => {
    g.costUSD += m.costUSD;
    g.costKnown = g.costKnown && m.costKnown;
    g.input_tokens += m.input_tokens;
    g.output_tokens += m.output_tokens;
    g.cache_read_input_tokens += m.cache_read_input_tokens;
    g.cache_creation_input_tokens += m.cache_creation_input_tokens;
    return g;
  }, { costUSD: 0, costKnown: true, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

  return {
    session: path.basename(transcript).replace(/\.jsonl$/i, ''),
    transcript,
    main: { messages: main.messages, models: main.models },
    subagents,
    models,
    grand,
    estimated: true, // dollars are a local-table estimate, not billed figures
  };
}

module.exports = { analyzeSession, locate };
