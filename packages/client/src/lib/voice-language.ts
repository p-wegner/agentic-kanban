export const DEFAULT_VOICE_LANGUAGE = "";
export const VOICE_LANGUAGE_STORAGE_KEY = "voice-input-language";

export interface VoiceLanguageOption {
  value: string;
  label: string;
}

export const VOICE_LANGUAGE_OPTIONS: VoiceLanguageOption[] = [
  { value: "", label: "Auto" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "de-DE", label: "Deutsch" },
  { value: "fr-FR", label: "French" },
  { value: "es-ES", label: "Spanish" },
  { value: "pt-BR", label: "Portuguese" },
  { value: "it-IT", label: "Italiano" },
  { value: "nl-NL", label: "Nederlands" },
  { value: "pl-PL", label: "Polski" },
  { value: "ru-RU", label: "Russian" },
  { value: "ja-JP", label: "Japanese" },
  { value: "ko-KR", label: "Korean" },
  { value: "zh-CN", label: "Chinese" },
];

export function normalizeVoiceLanguage(value: string | null | undefined): string {
  if (value == null) return DEFAULT_VOICE_LANGUAGE;
  return VOICE_LANGUAGE_OPTIONS.some((option) => option.value === value)
    ? value
    : DEFAULT_VOICE_LANGUAGE;
}

function getBrowserVoiceLanguageCandidates(): string[] {
  if (typeof navigator === "undefined") return [];
  const candidates = [
    ...(navigator.languages && navigator.languages.length ? Array.from(navigator.languages) : []),
    navigator.language,
  ];

  return Array.from(
    new Set(
      candidates
        .filter((language): language is string => typeof language === "string")
        .map((language) => language.trim().replace("_", "-")),
    ),
  ).filter(Boolean);
}

function getSupportedLanguageByLocale(locale: string): string {
  const lowerLocale = locale.toLowerCase();
  const exact = VOICE_LANGUAGE_OPTIONS.find(
    (option) => option.value.toLowerCase() === lowerLocale,
  );
  if (exact) return exact.value;

  const base = lowerLocale.split("-")[0];
  if (!base) return DEFAULT_VOICE_LANGUAGE;

  const byBase = VOICE_LANGUAGE_OPTIONS.find((option) =>
    option.value.toLowerCase().startsWith(`${base}-`),
  );
  return byBase ? byBase.value : DEFAULT_VOICE_LANGUAGE;
}

export function resolveVoiceLanguage(value: string | null | undefined): string {
  const normalizedPreference = normalizeVoiceLanguage(value);
  if (normalizedPreference) return normalizedPreference;

  const candidates = getBrowserVoiceLanguageCandidates();
  for (const candidate of candidates) {
    const supported = getSupportedLanguageByLocale(candidate);
    if (supported) return supported;
  }

  return DEFAULT_VOICE_LANGUAGE;
}

export function getVoiceLanguageLabel(value: string): string {
  return VOICE_LANGUAGE_OPTIONS.find((option) => option.value === value)?.label ?? "Auto";
}

export function loadVoiceLanguage(): string {
  if (typeof window === "undefined") return DEFAULT_VOICE_LANGUAGE;
  try {
    return normalizeVoiceLanguage(window.localStorage.getItem(VOICE_LANGUAGE_STORAGE_KEY));
  } catch {
    return DEFAULT_VOICE_LANGUAGE;
  }
}

export function saveVoiceLanguage(value: string): string {
  const normalized = normalizeVoiceLanguage(value);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(VOICE_LANGUAGE_STORAGE_KEY, normalized);
    } catch {
      // Local storage is best-effort; the current control state still applies.
    }
  }
  return normalized;
}
