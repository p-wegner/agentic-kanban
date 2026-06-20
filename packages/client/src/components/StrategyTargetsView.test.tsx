import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderPolicyProfileField } from "./ProviderPolicyProfileField.js";

describe("ProviderPolicyProfileField (AK-836)", () => {
  it("renders a dropdown of the available profiles for the provider", () => {
    const html = renderToStaticMarkup(
      <ProviderPolicyProfileField
        provider="claude"
        profileName="anth"
        availableProfiles={["anth", "dev", "mock"]}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Profile");
    expect(html).toContain("<select");
    // Every available profile is an option, plus a custom escape hatch.
    expect(html).toContain(">anth<");
    expect(html).toContain(">dev<");
    expect(html).toContain(">mock<");
    expect(html).toContain("Custom…");
    // The current value is the selected option.
    expect(html).toMatch(/value="anth"\s+selected/);
  });

  it("offers the default (empty) option when the profile is unset", () => {
    const html = renderToStaticMarkup(
      <ProviderPolicyProfileField
        provider="codex"
        profileName=""
        availableProfiles={["default", "gpt-5.5"]}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("<select");
    expect(html).toContain(">default<");
    expect(html).toContain(">gpt-5.5<");
  });

  it("falls back to a free-text input for a value not in the available list", () => {
    const html = renderToStaticMarkup(
      <ProviderPolicyProfileField
        provider="claude"
        profileName="legacy-profile"
        availableProfiles={["anth", "dev"]}
        onChange={() => {}}
      />,
    );
    // Unknown value must stay editable rather than be silently dropped.
    expect(html).not.toContain("<select");
    expect(html).toContain("<input");
    expect(html).toContain('value="legacy-profile"');
  });

  it("uses a free-text input when no profiles are available", () => {
    const html = renderToStaticMarkup(
      <ProviderPolicyProfileField
        provider="pi"
        profileName=""
        availableProfiles={[]}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("<select");
    expect(html).toContain(">default<");
    expect(html).toContain("Custom…");
  });
});
