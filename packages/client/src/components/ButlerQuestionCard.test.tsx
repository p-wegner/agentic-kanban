// @covers butler.askUserQuestion.card [ui, state-transition, boundary]
//
// The butler's AskUserQuestion card (#460). Two renderings matter and they must not
// be confusable: PENDING is answerable (options, "Other…", a submit button), RESOLVED
// is read-only and shows what was actually chosen — that is what keeps the transcript
// honest after a reload, where every replayed question is an answered one.
//
// There is no @testing-library/react in this package, so these are static-markup
// assertions (the repo convention — cf. Button.test.tsx, gateCardPolicy.test.tsx);
// the click/selection logic is covered by the reducer + server tests.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuestionCard } from "./ButlerChatParts.js";
import type { ButlerQuestionPrompt } from "../lib/butler-event-reducer.js";

const prompt: ButlerQuestionPrompt = {
  askId: "ask-1",
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
    {
      question: "Which extras do you want?",
      header: "Extras",
      multiSelect: true,
      options: [{ label: "Sprinkles" }, { label: "Sauce" }],
    },
  ],
};

describe("QuestionCard — pending", () => {
  const html = renderToStaticMarkup(<QuestionCard prompt={prompt} />);

  it("renders every question with its header chip, options and descriptions", () => {
    expect(html).toContain("Butler is asking");
    expect(html).toContain("Colour");
    expect(html).toContain("Which colour do you prefer?");
    expect(html).toContain("Blue");
    expect(html).toContain("The colour blue.");
    expect(html).toContain("Extras");
    expect(html).toContain("Which extras do you want?");
    expect(html).toContain("Sprinkles");
  });

  it("offers the free-text Other the tool's contract always implies", () => {
    expect(html).toContain("Other…");
  });

  it("marks a multiSelect question so the user knows more than one is allowed", () => {
    expect(html).toContain("choose any");
  });

  it("keeps submit disabled until every question has an answer", () => {
    expect(html).toContain("Send answer");
    expect(html).toContain("disabled");
    expect(html).toContain("Pick an option for each question.");
  });
});

describe("QuestionCard — resolved", () => {
  it("renders read-only with what was chosen, and no way to answer again", () => {
    const html = renderToStaticMarkup(
      <QuestionCard
        prompt={{
          ...prompt,
          resolved: {
            answers: [
              { question: "Which colour do you prefer?", header: "Colour", answers: ["Green"] },
              { question: "Which extras do you want?", header: "Extras", answers: ["Sauce", "Sprinkles"] },
            ],
          },
        }}
      />,
    );
    expect(html).toContain("Answered");
    expect(html).toContain("Green");
    expect(html).toContain("Sauce, Sprinkles");
    // The answerable affordances are gone.
    expect(html).not.toContain("Send answer");
    expect(html).not.toContain("Other…");
    expect(html).not.toContain("The colour blue.");
  });

  it("says the question was closed, with the reason, when it was denied instead of answered", () => {
    const html = renderToStaticMarkup(
      <QuestionCard prompt={{ ...prompt, resolved: { reason: "timeout" } }} />,
    );
    expect(html).toContain("Question closed");
    expect(html).toContain("Closed: timeout");
    expect(html).toContain("not answered");
    expect(html).not.toContain("Send answer");
  });
});
