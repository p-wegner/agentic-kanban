import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ButlerViewBody } from "../components/ButlerViewBody.js";
import { butlerChatMessageFixture, butlerTabStateFixture, butlerViewBodyPropsFixture } from "./fixtures/butlerViewBody.js";

/**
 * `ButlerViewBody` is the presentational half of `ButlerView` (#611) and takes 66 props — the
 * reason it had no test was the setup, not the component (#782). With the fixture builder the
 * static render is cheap, and no jsdom is involved: the component is pure, so
 * `renderToStaticMarkup` is the right harness rather than a browser one.
 */
describe("ButlerViewBody (static render)", () => {
  it("renders the open tab and its empty conversation", () => {
    const html = renderToStaticMarkup(<ButlerViewBody {...butlerViewBodyPropsFixture()} />);
    expect(html).toContain("Butler");
  });

  it("shows the no-tab state when no butler tab is selected", () => {
    // Mutation: render the chat pane regardless of `tab` — a project with no butler open
    // would show an input box wired to nothing.
    const html = renderToStaticMarkup(
      <ButlerViewBody {...butlerViewBodyPropsFixture({ tab: undefined, openTabs: [], tabStates: {} })} />,
    );
    expect(html).not.toContain("</textarea>");
  });

  it("renders the conversation's messages in order", () => {
    const tab = butlerTabStateFixture({
      chatMessages: [
        butlerChatMessageFixture({ id: "m1", role: "user", text: "what is stuck?" }),
        butlerChatMessageFixture({ id: "m2", role: "assistant", text: "two workspaces are awaiting review" }),
      ],
    });
    const html = renderToStaticMarkup(
      <ButlerViewBody {...butlerViewBodyPropsFixture({ tab, tabStates: { [tab.butlerId]: tab } })} />,
    );
    expect(html).toContain("what is stuck?");
    expect(html).toContain("two workspaces are awaiting review");
    expect(html.indexOf("what is stuck?")).toBeLessThan(html.indexOf("two workspaces are awaiting review"));
  });

  it("swaps Send for Stop while a turn is in flight", () => {
    // Mutation: render the Send button regardless of `tab.sending` — there is then no way to
    // interrupt a running turn, and a second Enter starts a concurrent one the server 409s.
    const render = (sending: boolean) => {
      const tab = butlerTabStateFixture({ sending, input: "hello" });
      return renderToStaticMarkup(
        <ButlerViewBody {...butlerViewBodyPropsFixture({ tab, tabStates: { [tab.butlerId]: tab } })} />,
      );
    };
    expect(render(true)).toContain('title="Stop the butler"');
    expect(render(true)).not.toContain('title="Send message"');
    expect(render(false)).toContain('title="Send message"');
    expect(render(false)).not.toContain('title="Stop the butler"');
  });

  it("disables Send until the input has non-whitespace content", () => {
    // Mutation: `disabled={!tab.input}` — a whitespace-only message would be sendable and the
    // butler would burn a turn on it.
    const render = (input: string) => {
      const tab = butlerTabStateFixture({ input });
      return renderToStaticMarkup(
        <ButlerViewBody {...butlerViewBodyPropsFixture({ tab, tabStates: { [tab.butlerId]: tab } })} />,
      );
    };
    const sendDisabled = /<button disabled=""[^>]*title="Send message"/;
    expect(render("")).toMatch(sendDisabled);
    expect(render("   ")).toMatch(sendDisabled);
    expect(render("hello")).not.toMatch(sendDisabled);
  });
});
