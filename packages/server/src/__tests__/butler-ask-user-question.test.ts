// @covers butler.askUserQuestion [error, state-transition, boundary, api]
//
// Behaviour: what the butler does with an `AskUserQuestion` tool call.
//
// Before #459 the answer was "always fail": no `canUseTool` handler was passed, so
// the SDK auto-denied every call and the model got an is_error tool_result whose
// whole content was the permission-prompt title "Answer questions?". The butler then
// re-asked in prose, burning a turn each time.
//
// The handler now PARKS the call for the human (#460) — but only when a human can
// actually see it. #461 is the guard that makes parking safe: with no interactive
// listener attached (the synchronous /butler/ask door used by the CLI and the MCP
// tool, a Butler view with no tab open, a scheduled turn) parking would hang the
// caller until the timeout, which is strictly worse than the instant failure. These
// tests pin every exit of the handler:
//
//   (1) error: no listener attached  → immediate deny naming the remedy, nothing parked.
//   (2) state-transition: listener attached → the questions are broadcast and the
//       promise stays pending until the user answers, then resolves ALLOW with the
//       answers folded into updatedInput (the measured-to-work shape).
//   (3) error: the turn's abort signal → deny, and the card is closed.
//   (4) error: the session is stopped while parked → deny, nothing left dangling.
//   (5) error: the human never answers → deny with "timed out" (fake timers).
//   (6) api: answering an askId that is not parked is refused (no silent success).
//   (7) boundary: any tool that is NOT AskUserQuestion keeps the pre-existing
//       bypass-permissions behaviour (allowed, input untouched).
//
// The SDK is never started here: the session uses the in-process "mock" backend, so
// the handler is exercised directly through `getButlerCanUseTool`.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ensureButlerSession,
  stopButlerSession,
  subscribeButler,
  answerButlerQuestion,
  getButlerCanUseTool,
  getButlerTranscript,
  normalizeButlerQuestions,
  hasInteractiveButlerListener,
  NO_INTERACTIVE_CLIENT_MESSAGE,
  QUESTION_TIMED_OUT_MESSAGE,
  BUTLER_QUESTION_TIMEOUT_MS,
  type ButlerEvent,
} from "../services/butler-sdk.service.js";

const ASK_INPUT: Record<string, unknown> = {
  questions: [
    {
      question: "Which colour do you prefer?",
      header: "Colour",
      multiSelect: false,
      options: [
        { label: "Blue", description: "The colour blue." },
        { label: "Green", description: "The colour green." },
      ],
    },
  ],
};

let seq = 0;
const projects: string[] = [];

function startSession(): string {
  const projectId = `ask-test-${++seq}`;
  projects.push(projectId);
  ensureButlerSession({ projectId, repoPath: process.cwd(), projectName: projectId, backend: "mock" });
  return projectId;
}

function callAskUserQuestion(projectId: string, signal: AbortSignal = new AbortController().signal) {
  const canUseTool = getButlerCanUseTool(projectId);
  expect(canUseTool).toBeTypeOf("function");
  return canUseTool!("AskUserQuestion", ASK_INPUT, { signal, toolUseID: "toolu_test" });
}

/** Resolve once `p` settles, or report "pending" after a macrotask turn. */
async function settledOrPending<T>(p: Promise<T>): Promise<T | "pending"> {
  return Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), 20))]);
}

afterEach(() => {
  vi.useRealTimers();
  for (const projectId of projects.splice(0)) stopButlerSession(projectId);
});

describe("butler AskUserQuestion — no human attached (#461)", () => {
  it("denies immediately with an actionable message instead of parking", async () => {
    const projectId = startSession();
    expect(hasInteractiveButlerListener(projectId)).toBe(false);

    const result = await callAskUserQuestion(projectId);

    expect(result).toEqual({ behavior: "deny", message: NO_INTERACTIVE_CLIENT_MESSAGE });
    // The message must name the remedy — that is the whole point of the ticket.
    expect(NO_INTERACTIVE_CLIENT_MESSAGE).toMatch(/plain text/i);
    expect(NO_INTERACTIVE_CLIENT_MESSAGE).toMatch(/no interactive client/i);
    // Nothing was parked, so a later answer cannot resolve anything.
    expect(answerButlerQuestion(projectId, "any", [{ question: "q", header: "h", answers: ["a"] }])).toBe(false);
  });

  it("does not count a NON-interactive subscriber as a human", async () => {
    // POST /:id/butler/ask (the CLI + `ask_butler` MCP door) subscribes a collector to
    // assemble the reply, and startSession subscribes one to persist the session id.
    // Neither can answer anything: the /ask caller is blocked waiting for exactly one
    // answer and has no UI. Counting them would park the question and hang that caller
    // for the full timeout — the precise failure #461 exists to prevent.
    const projectId = startSession();
    subscribeButler(projectId, () => {});
    expect(hasInteractiveButlerListener(projectId)).toBe(false);

    await expect(callAskUserQuestion(projectId)).resolves.toEqual({
      behavior: "deny",
      message: NO_INTERACTIVE_CLIENT_MESSAGE,
    });
  });

  it("denies rather than parking once the last listener disconnects", async () => {
    const projectId = startSession();
    const unsubscribe = subscribeButler(projectId, () => {}, "default", { interactive: true });
    unsubscribe();

    await expect(callAskUserQuestion(projectId)).resolves.toEqual({
      behavior: "deny",
      message: NO_INTERACTIVE_CLIENT_MESSAGE,
    });
  });
});

describe("butler AskUserQuestion — parked and answered (#460)", () => {
  it("broadcasts the questions, waits, and returns the answers as updatedInput", async () => {
    const projectId = startSession();
    const events: ButlerEvent[] = [];
    subscribeButler(projectId, (e) => events.push(e), "default", { interactive: true });

    const pending = callAskUserQuestion(projectId);
    // Still pending: nobody has answered yet.
    expect(await settledOrPending(pending)).toBe("pending");

    const asked = events.find((e) => e.type === "question");
    expect(asked).toBeDefined();
    const askId = (asked as { askId: string }).askId;
    expect((asked as { questions: unknown[] }).questions).toEqual([
      {
        question: "Which colour do you prefer?",
        header: "Colour",
        multiSelect: false,
        options: [
          { label: "Blue", description: "The colour blue." },
          { label: "Green", description: "The colour green." },
        ],
      },
    ]);

    expect(answerButlerQuestion(projectId, askId, [
      { question: "Which colour do you prefer?", header: "Colour", answers: ["Green"] },
    ])).toBe(true);

    // MEASURED shape: allow, with the answers folded into the tool input keyed by
    // question text (AskUserQuestionOutput.answers). NOT a deny-carrying-the-answer.
    expect(await pending).toEqual({
      behavior: "allow",
      updatedInput: { ...ASK_INPUT, answers: { "Which colour do you prefer?": "Green" } },
    });

    const resolved = events.find((e) => e.type === "question-resolved");
    expect(resolved).toMatchObject({ askId, answers: [{ header: "Colour", answers: ["Green"] }] });
  });

  it("comma-joins a multi-select answer and records ONLY answered questions in the transcript", async () => {
    const projectId = startSession();
    const events: ButlerEvent[] = [];
    subscribeButler(projectId, (e) => events.push(e), "default", { interactive: true });

    const pending = callAskUserQuestion(projectId);
    await settledOrPending(pending);
    const askId = (events.find((e) => e.type === "question") as { askId: string }).askId;

    answerButlerQuestion(projectId, askId, [
      { question: "Which colour do you prefer?", header: "Colour", answers: ["Green", "Blue"] },
    ]);
    const result = await pending;
    // Narrow the SDK's PermissionResult union instead of casting past it: only the "allow"
    // arm carries `updatedInput`, and that is precisely what this case is asserting about.
    if (result.behavior !== "allow") throw new Error(`expected an allow result, got ${result.behavior}`);
    expect(result.updatedInput?.answers).toEqual({
      "Which colour do you prefer?": "Green, Blue",
    });

    // Replayed on reload as a resolved card — never as an answerable question.
    const transcript = getButlerTranscript(projectId);
    expect(transcript).toHaveLength(1);
    expect(transcript[0].role).toBe("question");
    expect(transcript[0].question?.askId).toBe(askId);
    expect(transcript[0].question?.answers[0].answers).toEqual(["Green", "Blue"]);
    expect(transcript[0].text).toBe("Colour: Green, Blue");
  });

  it("refuses an answer for an askId that is not parked", async () => {
    const projectId = startSession();
    subscribeButler(projectId, () => {}, "default", { interactive: true });
    expect(answerButlerQuestion(projectId, "not-a-real-ask-id", [
      { question: "q", header: "h", answers: ["a"] },
    ])).toBe(false);
  });
});

describe("butler AskUserQuestion — the turn goes away (#461)", () => {
  it("denies when the turn is aborted (interrupt / session stop)", async () => {
    const projectId = startSession();
    const events: ButlerEvent[] = [];
    subscribeButler(projectId, (e) => events.push(e), "default", { interactive: true });
    const controller = new AbortController();

    const pending = callAskUserQuestion(projectId, controller.signal);
    expect(await settledOrPending(pending)).toBe("pending");

    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ behavior: "deny" });
    expect((result as { message: string }).message).toMatch(/interrupted/i);
    expect(events.some((e) => e.type === "question-resolved" && e.reason === "interrupted")).toBe(true);
  });

  it("denies when the butler session is stopped while a question is parked", async () => {
    const projectId = startSession();
    subscribeButler(projectId, () => {}, "default", { interactive: true });

    const pending = callAskUserQuestion(projectId);
    expect(await settledOrPending(pending)).toBe("pending");

    stopButlerSession(projectId);
    const result = await pending;
    expect(result).toMatchObject({ behavior: "deny" });
    expect((result as { message: string }).message).toMatch(/stopped/i);
  });

  it("denies with a timeout message when nobody ever answers", async () => {
    vi.useFakeTimers();
    const projectId = startSession();
    subscribeButler(projectId, () => {}, "default", { interactive: true });

    const pending = callAskUserQuestion(projectId);
    // Let the handler park before the clock jumps.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(BUTLER_QUESTION_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ behavior: "deny", message: QUESTION_TIMED_OUT_MESSAGE });
    expect(QUESTION_TIMED_OUT_MESSAGE).toMatch(/timed out/i);
  });
});

describe("butler canUseTool — everything else is untouched", () => {
  it("allows a non-AskUserQuestion tool with the input unchanged", async () => {
    const projectId = startSession();
    const canUseTool = getButlerCanUseTool(projectId)!;
    const input = { command: "ls" };
    await expect(canUseTool("Bash", input, { signal: new AbortController().signal, toolUseID: "t1" })).resolves.toEqual({
      behavior: "allow",
      updatedInput: input,
    });
  });

  it("denies a malformed question payload rather than parking an empty card", async () => {
    const projectId = startSession();
    subscribeButler(projectId, () => {}, "default", { interactive: true });
    const canUseTool = getButlerCanUseTool(projectId)!;
    const result = await canUseTool("AskUserQuestion", { questions: [] }, {
      signal: new AbortController().signal,
      toolUseID: "t2",
    });
    expect(result).toMatchObject({ behavior: "deny" });
  });
});

describe("normalizeButlerQuestions", () => {
  it("caps at the tool's 4-question maximum and fills a missing header", () => {
    const many = { questions: Array.from({ length: 6 }, (_, i) => ({ question: `Question number ${i}?`, options: [{ label: "a", description: "d" }] })) };
    const out = normalizeButlerQuestions(many);
    expect(out).toHaveLength(4);
    expect(out[0].header).toBe("Question num"); // first 12 chars, per the tool's header contract
    expect(out[0].multiSelect).toBe(false);
  });

  it("drops options with no label and questions with no text", () => {
    const out = normalizeButlerQuestions({
      questions: [
        { question: "", header: "X", options: [{ label: "a", description: "d" }] },
        { question: "Real?", header: "Y", multiSelect: true, options: [{ description: "no label" }, { label: "ok" }] },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].multiSelect).toBe(true);
    expect(out[0].options).toEqual([{ label: "ok", description: undefined }]);
  });

  it("returns nothing for a payload with no questions array", () => {
    expect(normalizeButlerQuestions({})).toEqual([]);
    expect(normalizeButlerQuestions({ questions: "nope" })).toEqual([]);
  });
});
