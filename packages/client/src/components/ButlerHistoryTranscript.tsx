// The history-transcript message list, lifted out of ButlerViewBody (#800).
//
// It moved for two reasons that point the same way. ButlerViewBody is one of the
// client's genuinely over-long components and is on the shrink-only nloc ring
// (#763), so the keying #792 added had to earn its place there — and it does not:
// nothing else in that component reads these keys. Keeping the derivation beside
// its only consumer is also what stops the next edit re-deriving identity from an
// array index, which is the bug #792 fixed.
import type { ButlerSessionMessage } from "@agentic-kanban/shared";
import { ChatBubble } from "./ButlerChatParts.js";

/**
 * Stable identity for a history-transcript row (#792). `ButlerSessionMessage` carries no id of
 * its own, so the key is the composite the ticket prescribes — author + created-at + a counter
 * scoped to that (role, ts) pair — never the array index. It does not shift when a row is
 * prepended or dropped, and it does not change while a message's text streams in (unlike a
 * text-derived key). Exported for the render test.
 */
export function historyMessageKeys(messages: readonly ButlerSessionMessage[]): string[] {
  const seen = new Map<string, number>();
  return messages.map((msg) => {
    const identity = `${msg.role}:${msg.ts}`;
    const nth = seen.get(identity) ?? 0;
    seen.set(identity, nth + 1);
    return `hist-${identity}#${nth}`;
  });
}

export function HistoryTranscriptMessages({ messages }: { messages: readonly ButlerSessionMessage[] }) {
  const keys = historyMessageKeys(messages);
  return (
    <div className="max-w-3xl mx-auto">
      {messages.map((msg, i) => (
        <ChatBubble key={keys[i]} msg={{ id: keys[i]!, role: msg.role, text: msg.text, ts: msg.ts }} />
      ))}
    </div>
  );
}
