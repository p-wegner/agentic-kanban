import ReactMarkdown from "react-markdown";
import { useMentionContext, type MentionIssue } from "../lib/MentionContext";

function TicketMentionChip({ issueId }: { issueId: string }) {
  const { issues, onMentionClick } = useMentionContext();
  const issue = issues.find((i) => i.id === issueId);

  if (!issue) {
    return (
      <span className="text-gray-400 bg-gray-100 rounded px-1 py-0.5 text-xs">
        #deleted
      </span>
    );
  }

  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMentionClick(issueId);
      }}
      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 text-xs font-medium hover:bg-brand-100 cursor-pointer border border-brand-200 dark:border-brand-700"
      title={issue.title}
    >
      #{issue.issueNumber}
      <span className="text-brand-500 dark:text-brand-400 font-normal truncate max-w-[120px]">
        {issue.title}
      </span>
    </button>
  );
}

function buildLookup(
  issues: MentionIssue[],
): Map<number, { id: string; title: string }> {
  const map = new Map<number, { id: string; title: string }>();
  for (const issue of issues) {
    if (issue.issueNumber != null) {
      map.set(issue.issueNumber, { id: issue.id, title: issue.title });
    }
  }
  return map;
}

function replaceMentions(
  text: string,
  lookup: Map<number, { id: string; title: string }>,
): string {
  return text.replace(/#(\d+)/g, (match, numStr: string) => {
    const num = Number(numStr);
    const issue = lookup.get(num);
    if (!issue) return match;
    return `[#${num} ${issue.title}](mention:${issue.id})`;
  });
}

function preprocessMentions(
  text: string,
  lookup: Map<number, { id: string; title: string }>,
): string {
  const codeBlockRegex = /(```[\s\S]*?```|`[^`]+`)/g;
  const segments: string[] = [];
  let lastIndex = 0;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push(replaceMentions(text.slice(lastIndex, match.index), lookup));
    }
    segments.push(match[0]);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push(replaceMentions(text.slice(lastIndex), lookup));
  }
  return segments.join("");
}

export default function TicketMentionRenderer({
  children,
}: {
  children: string;
}) {
  const { issues } = useMentionContext();
  const lookup = buildLookup(issues);
  const preprocessed = preprocessMentions(children, lookup);

  return (
    <ReactMarkdown
      components={{
        a: ({ href, children: linkChildren }) => {
          if (href?.startsWith("mention:")) {
            const issueId = href.slice(8);
            return <TicketMentionChip issueId={issueId} />;
          }
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              {linkChildren}
            </a>
          );
        },
      }}
    >
      {preprocessed}
    </ReactMarkdown>
  );
}
