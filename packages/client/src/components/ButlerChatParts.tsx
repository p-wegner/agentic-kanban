import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  formatToolLabel,
  type ButlerChatMessage as ChatMessage,
  type ButlerToolCall as ToolCall,
  type ButlerQuestionAnswer,
  type ButlerQuestionPrompt,
} from "../lib/butler-event-reducer.js";
import { toolHint, formatRelativeTs } from "../lib/butler-format.js";
import { Icon, Spinner } from "./Icon.js";

const toolIcon = (status: ToolCall["status"]) => {
  if (status === "pending") {
    return (
      <Spinner className="w-3 h-3 animate-spin shrink-0 text-gray-400" />
    );
  }
  if (status === "error") {
    return (
      <Icon className="w-3 h-3 shrink-0 text-red-500" strokeWidth={2.5} strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></Icon>
    );
  }
  return (
    <Icon className="w-3 h-3 shrink-0 text-green-500" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></Icon>
  );
};

function ToolCallCard({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const hint = toolHint(tool.name, tool.input);
  const hasDetail = (tool.input && Object.keys(tool.input).length > 0) || tool.output != null;
  const inputJson = tool.input && Object.keys(tool.input).length > 0
    ? JSON.stringify(tool.input, null, 2)
    : "";

  return (
    <div className="flex justify-center mb-1.5">
      <div className="w-full max-w-[80%]">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((o) => !o)}
          disabled={!hasDetail}
          className={`group flex items-center gap-1.5 w-full text-left px-2.5 py-1 rounded-md border border-gray-200 dark:border-gray-700/70 bg-gray-50 dark:bg-gray-800/50 text-[11px] text-gray-500 dark:text-gray-400 ${hasDetail ? "hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer" : "cursor-default"}`}
        >
          {toolIcon(tool.status)}
          <span className="font-medium text-gray-600 dark:text-gray-300 shrink-0">{formatToolLabel(tool.name)}</span>
          {hint && <span className="truncate font-mono text-gray-400 dark:text-gray-500">{hint}</span>}
          {hasDetail && (
            <Icon className={`w-3 h-3 ml-auto shrink-0 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`} strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></Icon>
          )}
        </button>
        {open && (
          <div className="mt-1 space-y-1.5 rounded-md border border-gray-200 dark:border-gray-700/70 bg-white dark:bg-gray-900/60 p-2">
            {inputJson && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-0.5">Input</div>
                <pre className="text-[11px] font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{inputJson}</pre>
              </div>
            )}
            {tool.output != null && (
              <div>
                <div className={`text-[10px] uppercase tracking-wide mb-0.5 ${tool.status === "error" ? "text-red-500" : "text-gray-400 dark:text-gray-500"}`}>{tool.status === "error" ? "Error" : "Output"}</div>
                <pre className={`text-[11px] font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto ${tool.status === "error" ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}`}>{tool.output || "(empty)"}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A parked AskUserQuestion (#460): one block per question (1–4) with a header chip,
 * option chips carrying their descriptions, multi-select support, and a free-text
 * "Other" (the tool's contract always offers one implicitly). Once answered — or
 * denied by the server (timeout/interrupt) — it renders read-only, so the transcript
 * stays honest across a reload.
 */
export function QuestionCard({
  prompt,
  onAnswer,
}: {
  prompt: ButlerQuestionPrompt;
  onAnswer?: (askId: string, answers: ButlerQuestionAnswer[]) => Promise<void> | void;
}) {
  // Selected option labels per question index; "Other" text kept separately.
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const resolved = prompt.resolved;

  function answersFor(i: number): string[] {
    const chosen = picked[i] ?? [];
    const free = (other[i] ?? "").trim();
    return free ? [...chosen, free] : chosen;
  }

  const complete = prompt.questions.every((_, i) => answersFor(i).length > 0);

  function toggle(i: number, label: string, multiSelect: boolean) {
    setPicked((prev) => {
      const cur = prev[i] ?? [];
      if (!multiSelect) return { ...prev, [i]: cur.includes(label) ? [] : [label] };
      return { ...prev, [i]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
    });
  }

  async function submit() {
    if (!onAnswer || submitting || !complete) return;
    setSubmitting(true);
    try {
      await onAnswer(prompt.askId, prompt.questions.map((q, i) => ({
        question: q.question,
        header: q.header,
        answers: answersFor(i),
      })));
    } finally {
      setSubmitting(false);
    }
  }

  const answeredBy = new Map((resolved?.answers ?? []).map((a) => [a.question, a.answers]));

  return (
    <div className="flex justify-start mb-3" data-testid="butler-question-card">
      <div className="w-full max-w-[80%] rounded-2xl rounded-tl-md border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 shadow-sm">
        <div className="flex items-center gap-1.5 mb-2">
          <Icon className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></Icon>
          <span className="text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
            {resolved ? (resolved.answers ? "Answered" : "Question closed") : "Butler is asking"}
          </span>
        </div>

        {prompt.questions.map((q, i) => {
          const given = answeredBy.get(q.question);
          const selected = picked[i] ?? [];
          return (
            <div key={`${q.header}-${i}`} className={i > 0 ? "mt-3 pt-3 border-t border-amber-200 dark:border-amber-800/60" : ""}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-200/70 dark:bg-amber-800/60 text-amber-800 dark:text-amber-200">{q.header}</span>
                {q.multiSelect && !resolved && <span className="text-[10px] text-amber-700/80 dark:text-amber-400/80">choose any</span>}
              </div>
              <p className="text-sm text-gray-800 dark:text-gray-200 mb-2">{q.question}</p>

              {resolved ? (
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {given?.length ? given.join(", ") : <span className="italic text-gray-500 dark:text-gray-400">not answered</span>}
                </p>
              ) : (
                <div className="space-y-1">
                  {q.options.map((opt) => {
                    const on = selected.includes(opt.label);
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => toggle(i, opt.label, q.multiSelect)}
                        className={`w-full text-left px-2.5 py-1.5 rounded-lg border text-sm transition-colors ${on
                          ? "border-amber-500 bg-amber-100 dark:bg-amber-800/50 text-amber-900 dark:text-amber-100"
                          : "border-amber-200 dark:border-amber-800/60 bg-white/70 dark:bg-gray-900/40 text-gray-700 dark:text-gray-300 hover:bg-amber-100/70 dark:hover:bg-amber-900/40"}`}
                      >
                        <span className="font-medium">{opt.label}</span>
                        {opt.description && <span className="block text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{opt.description}</span>}
                      </button>
                    );
                  })}
                  {otherOpen[i] ? (
                    <input
                      autoFocus
                      value={other[i] ?? ""}
                      onChange={(e) => setOther((prev) => ({ ...prev, [i]: e.target.value }))}
                      placeholder="Something else…"
                      aria-label={`Other answer for ${q.header}`}
                      className="w-full px-2.5 py-1.5 rounded-lg border border-amber-300 dark:border-amber-700/60 bg-white dark:bg-gray-900/60 text-sm text-gray-800 dark:text-gray-200"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setOtherOpen((prev) => ({ ...prev, [i]: true }))}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg border border-dashed border-amber-300 dark:border-amber-800/60 text-sm text-gray-500 dark:text-gray-400 hover:bg-amber-100/70 dark:hover:bg-amber-900/40"
                    >
                      Other…
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {resolved?.reason && !resolved.answers && (
          <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">Closed: {resolved.reason}</p>
        )}

        {!resolved && (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!complete || submitting || !onAnswer}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-600 hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed text-white"
            >
              {submitting ? "Sending…" : "Send answer"}
            </button>
            {!complete && <span className="text-[11px] text-gray-500 dark:text-gray-400">Pick an option for each question.</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Renders one chat message (user / assistant-markdown / tool-call / question / activity line). */
export function ChatBubble({ msg, onAnswerQuestion }: {
  msg: ChatMessage;
  onAnswerQuestion?: (askId: string, answers: ButlerQuestionAnswer[]) => Promise<void> | void;
}) {
  if (msg.role === "question" && msg.question) {
    return <QuestionCard prompt={msg.question} onAnswer={onAnswerQuestion} />;
  }

  if (msg.role === "user") {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%] bg-brand-600 text-white rounded-2xl rounded-tr-md px-4 py-2.5 shadow-sm">
          <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
          <p className="text-[10px] text-brand-200 mt-1 text-right">{formatRelativeTs(msg.ts)}</p>
        </div>
      </div>
    );
  }

  if (msg.role === "tool" && msg.tool) {
    return <ToolCallCard tool={msg.tool} />;
  }

  if (msg.role === "activity") {
    return (
      <div className="flex justify-center mb-1">
        <span className="text-[11px] text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 rounded-full">
          {msg.text}
        </span>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[80%] bg-surface-raised dark:bg-surface-raised-dark border border-gray-200 dark:border-gray-700 rounded-2xl rounded-tl-md px-4 py-2.5 shadow-sm">
        <div className="text-sm text-gray-800 dark:text-gray-200 prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-1 prose-table:my-1 prose-headings:mt-2 prose-headings:mb-1">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
        <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{formatRelativeTs(msg.ts)}</p>
      </div>
    </div>
  );
}
