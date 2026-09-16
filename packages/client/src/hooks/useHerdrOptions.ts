import { useState } from "react";
import { deriveHerdrOptions, EMPTY_HERDR_OPTIONS, type HerdrBootstrap, type HerdrOptions } from "../lib/settingsPanelState.js";

/**
 * Herdr availability + profile state for the Settings panel (#1144), lifted out of
 * `SettingsPanel.tsx` itself — the panel's bootstrap effect only needs to call
 * `applyBootstrap(boot)` once the settings-bootstrap response lands.
 */
export function useHerdrOptions(): { herdr: HerdrOptions; applyHerdrBootstrap: (boot: HerdrBootstrap) => void } {
  const [herdr, setHerdr] = useState(EMPTY_HERDR_OPTIONS);
  return { herdr, applyHerdrBootstrap: (boot: HerdrBootstrap) => setHerdr(deriveHerdrOptions(boot)) };
}
