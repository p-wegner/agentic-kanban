import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_VOICE_LANGUAGE,
  getVoiceLanguageLabel,
  loadVoiceLanguage,
  normalizeVoiceLanguage,
  saveVoiceLanguage,
  VOICE_LANGUAGE_STORAGE_KEY,
} from "./voice-language.js";

describe("voice-language preferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to browser auto instead of forcing English", () => {
    expect(DEFAULT_VOICE_LANGUAGE).toBe("");
    expect(normalizeVoiceLanguage(null)).toBe("");
    expect(getVoiceLanguageLabel("")).toBe("Auto");
  });

  it("accepts supported speech recognition languages", () => {
    expect(normalizeVoiceLanguage("de-DE")).toBe("de-DE");
    expect(getVoiceLanguageLabel("de-DE")).toBe("Deutsch");
  });

  it("falls back to auto for unsupported persisted values", () => {
    expect(normalizeVoiceLanguage("xx-invalid")).toBe("");
    expect(getVoiceLanguageLabel("xx-invalid")).toBe("Auto");
  });

  it("loads and saves the normalized preference in local storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          store.set(key, value);
        }),
      },
    });

    expect(loadVoiceLanguage()).toBe("");
    expect(saveVoiceLanguage("fr-FR")).toBe("fr-FR");
    expect(store.get(VOICE_LANGUAGE_STORAGE_KEY)).toBe("fr-FR");
    expect(loadVoiceLanguage()).toBe("fr-FR");
  });

  it("saves auto when an unsupported value is selected", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          store.set(key, value);
        }),
      },
    });

    expect(saveVoiceLanguage("not-a-real-locale")).toBe("");
    expect(store.get(VOICE_LANGUAGE_STORAGE_KEY)).toBe("");
  });
});
