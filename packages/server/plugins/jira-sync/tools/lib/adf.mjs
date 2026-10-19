// Atlassian Document Format <-> Markdown (#1624). Pure and zero-dependency, like the
// rest of the plugin. ADF -> Markdown is used on pull (descriptions, comments);
// Markdown -> ADF is used on push (comments), so the board's Markdown renders in Jira
// instead of showing literal `_`/`**`/backticks.

// ---------------------------------------------------------------- ADF -> Markdown

function applyMarks(text, marks = []) {
  let out = text;
  let href = null;
  let code = false;
  for (const mark of marks) {
    if (mark.type === "code") code = true;
    else if (mark.type === "link") href = mark.attrs?.href ?? null;
  }
  if (code) out = `\`${out}\``;
  for (const mark of marks) {
    if (mark.type === "strong") out = `**${out}**`;
    else if (mark.type === "em") out = `_${out}_`;
    else if (mark.type === "strike") out = `~~${out}~~`;
  }
  if (href) out = `[${out}](${href})`;
  return out;
}

function inline(nodes = []) {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return applyMarks(node.text ?? "", node.marks);
        case "hardBreak":
          return "  \n";
        case "mention":
          return node.attrs?.text ?? `@${node.attrs?.displayName ?? node.attrs?.id ?? "user"}`;
        case "emoji":
          return node.attrs?.text ?? node.attrs?.shortName ?? "";
        case "inlineCard":
          return node.attrs?.url ?? "";
        case "status":
          return `[${node.attrs?.text ?? ""}]`;
        default:
          return Array.isArray(node.content) ? inline(node.content) : (node.text ?? "");
      }
    })
    .join("");
}

function indentLines(text, prefix, firstPrefix = prefix) {
  return text
    .split("\n")
    .map((line, i) => (line === "" ? "" : (i === 0 ? firstPrefix : prefix) + line))
    .join("\n");
}

function listToMarkdown(node, ordered) {
  const start = node.attrs?.order ?? 1;
  return (node.content ?? [])
    .map((item, i) => {
      const marker = ordered ? `${start + i}. ` : "- ";
      // Tight list: an item's blocks (paragraph, nested list) are joined by one newline.
      const body = (item.content ?? []).map(block).filter((b) => b !== "").join("\n");
      return indentLines(body, " ".repeat(marker.length), marker);
    })
    .join("\n");
}

function tableToMarkdown(node) {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) => blocks(cell.content ?? []).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|")),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => Array.from({ length: width }, (_, i) => r[i] ?? "");
  const line = (r) => `| ${pad(r).join(" | ")} |`;
  return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

function block(node) {
  switch (node.type) {
    case "paragraph":
      return inline(node.content);
    case "heading":
      return `${"#".repeat(Math.min(Math.max(node.attrs?.level ?? 1, 1), 6))} ${inline(node.content)}`;
    case "bulletList":
      return listToMarkdown(node, false);
    case "orderedList":
      return listToMarkdown(node, true);
    case "codeBlock": {
      const text = (node.content ?? []).map((n) => n.text ?? "").join("");
      return `\`\`\`${node.attrs?.language ?? ""}\n${text}\n\`\`\``;
    }
    case "blockquote":
      return indentLines(blocks(node.content ?? []).trim(), "> ");
    case "rule":
      return "---";
    case "table":
      return tableToMarkdown(node);
    case "panel":
    case "expand":
    case "nestedExpand":
      return blocks(node.content ?? []).trim();
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "";
    default:
      return Array.isArray(node.content) ? inline(node.content) : (node.text ?? "");
  }
}

function blocks(nodes) {
  return nodes.map(block).filter((s) => s !== "").join("\n\n");
}

/** ADF document (or plain string / null) -> Markdown string, or null when not a document. */
export function adfToMarkdown(doc) {
  if (doc == null) return null;
  if (typeof doc === "string") return doc;
  if (typeof doc !== "object" || !Array.isArray(doc.content)) return null;
  return blocks(doc.content).trim();
}

// ---------------------------------------------------------------- Markdown -> ADF

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\s][^*\n]*\*)|((?<![A-Za-z0-9])_[^_\s][^_\n]*_(?![A-Za-z0-9]))|(\[[^\]\n]+\]\([^)\s]+\))/g;

function textNode(text, marks) {
  const node = { type: "text", text };
  if (marks?.length) node.marks = marks;
  return node;
}

function parseInline(text, marks = []) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(textNode(text.slice(last, m.index), marks));
    const tok = m[0];
    if (m[1]) out.push(textNode(tok.slice(1, -1), [...marks, { type: "code" }]));
    else if (m[2] || m[3]) out.push(...parseInline(tok.slice(2, -2), [...marks, { type: "strong" }]));
    else if (m[4]) out.push(...parseInline(tok.slice(2, -2), [...marks, { type: "strike" }]));
    else if (m[5] || m[6]) out.push(...parseInline(tok.slice(1, -1), [...marks, { type: "em" }]));
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      out.push(...parseInline(link[1], [...marks, { type: "link", attrs: { href: link[2] } }]));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(textNode(text.slice(last), marks));
  return out;
}

function inlineWithBreaks(lines) {
  const out = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push({ type: "hardBreak" });
    out.push(...parseInline(line));
  });
  return out;
}

const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;

function parseList(lines, start, baseIndent) {
  const ordered = /\d+\./.test(LIST_RE.exec(lines[start])[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m || m[1].length < baseIndent) break;
    if (m[1].length > baseIndent) {
      // A deeper list belongs to the previous item.
      const nested = parseList(lines, i, m[1].length);
      items[items.length - 1]?.content.push(nested.node);
      i = nested.next;
      continue;
    }
    if (/\d+\./.test(m[2]) !== ordered) break;
    items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInline(m[3]) }] });
    i++;
  }
  return { node: { type: ordered ? "orderedList" : "bulletList", content: items }, next: i };
}

/** Markdown string -> ADF document. Covers the subset the converter above emits. */
export function markdownToAdf(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const content = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const node = { type: "codeBlock", content: body.length ? [{ type: "text", text: body.join("\n") }] : [] };
      if (fence[1]) node.attrs = { language: fence[1] };
      content.push(node);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      content.push({ type: "heading", attrs: { level: heading[1].length }, content: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      content.push({ type: "rule" });
      i++;
      continue;
    }
    if (LIST_RE.test(line)) {
      const list = parseList(lines, i, LIST_RE.exec(line)[1].length);
      content.push(list.node);
      i = list.next;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ""));
      content.push({ type: "blockquote", content: markdownToAdf(quoted.join("\n")).content });
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !/^>\s?/.test(lines[i])
    ) {
      para.push(lines[i++].replace(/ {2,}$/, ""));
    }
    content.push({ type: "paragraph", content: inlineWithBreaks(para) });
  }
  if (content.length === 0) content.push({ type: "paragraph", content: [] });
  return { type: "doc", version: 1, content };
}
