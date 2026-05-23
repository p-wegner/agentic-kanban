import { createContext, useContext } from "react";

export interface MentionIssue {
  id: string;
  issueNumber: number | null;
  title: string;
}

interface MentionContextValue {
  issues: MentionIssue[];
  onMentionClick: (issueId: string) => void;
}

const MentionContext = createContext<MentionContextValue>({
  issues: [],
  onMentionClick: () => {},
});

export const MentionProvider = MentionContext.Provider;

export function useMentionContext() {
  return useContext(MentionContext);
}
