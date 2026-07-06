import { beforeEach, describe, expect, it } from "vitest";
import { boardCursorActions, useBoardCursorStore } from "./boardCursorStore.js";

describe("boardCursorStore", () => {
  beforeEach(() => {
    useBoardCursorStore.setState({ keyboardCursorIssueId: null });
  });

  it("sets and clears the keyboard cursor", () => {
    useBoardCursorStore.getState().setKeyboardCursorIssueId("issue-1");
    expect(useBoardCursorStore.getState().keyboardCursorIssueId).toBe("issue-1");
    useBoardCursorStore.getState().setKeyboardCursorIssueId(null);
    expect(useBoardCursorStore.getState().keyboardCursorIssueId).toBeNull();
  });

  it("non-reactive actions read/write the live value (ref replacement)", () => {
    boardCursorActions.setKeyboardCursorIssueId("issue-2");
    expect(boardCursorActions.getKeyboardCursorIssueId()).toBe("issue-2");
    boardCursorActions.setKeyboardCursorIssueId(null);
    expect(boardCursorActions.getKeyboardCursorIssueId()).toBeNull();
  });
});
