import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  loadVoiceLanguage,
  resolveVoiceLanguage,
  saveVoiceLanguage,
  VOICE_LANGUAGE_OPTIONS,
} from "../lib/voice-language.js";
import { showToast } from "./Toast.js";

interface ButlerVoiceButtonProps {
  /** Disable the button (e.g. while the butler is processing a turn). */
  disabled?: boolean;
  /**
   * Append a finalized chunk of dictated text to the message input.
   * Called incrementally as the speech recognizer finalizes phrases.
   */
  onTranscript: (chunk: string) => void;
  /** Optional live preview of the not-yet-finalized phrase. */
  onInterim?: (interim: string) => void;
  /** Called when the user stops a recording session (e.g. key release). */
  onStop?: () => void;
  /** Optional hook when a recording session starts. */
  onStart?: () => void;
  /**
   * Visual variant.
   * - `"compact"` (default): square icon-only button matching the send button footprint.
   * - `"prominent"`: larger, higher-contrast pill with an icon + "Dictate"/"Listening..." label,
   *   for use in the top toolbar where the action should be easy to discover.
   */
  variant?: "compact" | "prominent";
}

type RecordingState = "idle" | "recording";

// Web Speech API types (may not be in all TS lib versions). Mirrors the
// declarations in VoiceInboxButton.tsx - kept local so the two voice features
// stay independent.
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognitionType extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
}

export type ButlerVoiceButtonHandle = {
  start: () => void;
  stop: () => void;
  isRecording: () => boolean;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionType) | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function sanitizeSpeechText(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200B\u200C\u200D\u2060\u180E\u200E\u200F\uFEFF]/g, "")
    .trim();
}

/**
 * Microphone button for the butler chat input. Dictates speech into the
 * message textarea (via {@link ButlerVoiceButtonProps.onTranscript}) instead
 * of auto-sending, so the user can edit before submitting.
 */
export const ButlerVoiceButton = forwardRef<ButlerVoiceButtonHandle, ButlerVoiceButtonProps>(({
  disabled,
  onTranscript,
  onInterim,
  onStop,
  onStart,
  variant = "compact",
}, ref) => {
  const [state, setState] = useState<RecordingState>("idle");
  const [voiceLanguage, setVoiceLanguage] = useState(loadVoiceLanguage);
  const recognitionRef = useRef<SpeechRecognitionType | null>(null);
  const stopRequestedRef = useRef(false);
  const pointerDownRef = useRef(false);
  const suppressClickRef = useRef(false);

  // Animated waveform bars (3 bars, sine-wave phase offset) while recording.
  const [waveBars, setWaveBars] = useState([0.3, 0.7, 0.4]);
  const waveAnimRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (state === "recording") {
      let t = 0;
      waveAnimRef.current = setInterval(() => {
        t += 0.3;
        setWaveBars([
          0.3 + 0.5 * Math.abs(Math.sin(t)),
          0.3 + 0.5 * Math.abs(Math.sin(t + 1)),
          0.3 + 0.5 * Math.abs(Math.sin(t + 2)),
        ]);
      }, 80);
    } else {
      if (waveAnimRef.current) clearInterval(waveAnimRef.current);
      waveAnimRef.current = null;
      setWaveBars([0.3, 0.7, 0.4]);
    }
    return () => {
      if (waveAnimRef.current) clearInterval(waveAnimRef.current);
    };
  }, [state]);

  const finishRecording = useCallback((shouldSubmit = false) => {
    recognitionRef.current = null;
    onInterim?.("");
    setState("idle");
    const submit = shouldSubmit;
    stopRequestedRef.current = false;
    if (submit && onStop) {
      onStop();
    }
  }, [onInterim, onStop]);

  const stopRecording = useCallback(() => {
    if (disabled) return;
    if (!recognitionRef.current) {
      if (state === "recording") {
        finishRecording(false);
      }
      return;
    }

    stopRequestedRef.current = true;
    recognitionRef.current.stop();
  }, [disabled, state, finishRecording]);

  const startRecording = useCallback(() => {
    if (disabled) return;
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) {
      showToast("Voice input requires a browser with Web Speech API (Chrome/Edge)", "error");
      return;
    }

    const existing = recognitionRef.current;
    if (existing) {
      existing.abort();
      recognitionRef.current = null;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    const recognitionLanguage = resolveVoiceLanguage(voiceLanguage);
    if (recognitionLanguage) {
      recognition.lang = recognitionLanguage;
    }
    stopRequestedRef.current = false;
    onStart?.();

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      // Start from event.resultIndex so we only process NEW results.
      // event.results is cumulative (contains all results from session start),
      // so iterating from 0 would re-append previously-finalized text.
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const chunk = sanitizeSpeechText(res[0].transcript);
        if (res.isFinal) {
          if (chunk) {
            onTranscript(`${chunk} `);
          }
        } else {
          interim += chunk;
        }
      }
      onInterim?.(interim);
    };

    recognition.onerror = (event: Event) => {
      const errCode = (event as unknown as { error?: string }).error;
      // "no-speech"/"aborted" are benign (user stopped or paused); only surface real errors.
      if (errCode && errCode !== "no-speech" && errCode !== "aborted") {
        showToast(`Voice input error: ${errCode}`, "error");
      }
      finishRecording(stopRequestedRef.current);
    };

    recognition.onend = () => {
      finishRecording(stopRequestedRef.current);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setState("recording");
  }, [disabled, onInterim, onStart, onTranscript, finishRecording, voiceLanguage]);

  const handlePointerDown = useCallback(() => {
    if (disabled) return;
    pointerDownRef.current = true;
    suppressClickRef.current = true;
    if (state === "idle") {
      startRecording();
    } else if (state === "recording") {
      stopRecording();
    }
  }, [disabled, state, startRecording, stopRecording]);

  const handlePointerUp = useCallback(() => {
    if (disabled) return;
    pointerDownRef.current = false;
    if (state === "recording") {
      stopRecording();
    }
  }, [disabled, state, stopRecording]);

  const handlePointerLeave = useCallback(() => {
    if (pointerDownRef.current) {
      pointerDownRef.current = false;
      if (state === "recording") {
        stopRecording();
      }
    }
  }, [state, stopRecording]);

  const handleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }

    if (disabled) return;
    if (state === "idle") {
      startRecording();
    } else {
      stopRecording();
    }
  }, [disabled, state, startRecording, stopRecording]);

  useImperativeHandle(ref, () => ({
    start: () => {
      if (state !== "recording") {
        startRecording();
      }
    },
    stop: () => {
      if (state === "recording") {
        stopRecording();
      }
    },
    isRecording: () => state === "recording",
  }), [state, startRecording, stopRecording]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
    };
  }, []);

  const isRecording = state === "recording";
  const isProminent = variant === "prominent";
  const languageSelect = (
    <select
      value={voiceLanguage}
      onChange={(e) => setVoiceLanguage(saveVoiceLanguage(e.target.value))}
      disabled={disabled || isRecording}
      aria-label="Voice input language"
      title="Voice input language"
      className={[
        "shrink-0 rounded border px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-500",
        isProminent
          ? "border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark text-gray-700 dark:text-gray-200"
          : "border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300",
        "disabled:opacity-40 disabled:cursor-not-allowed",
      ].join(" ")}
    >
      {VOICE_LANGUAGE_OPTIONS.map((option) => (
        <option key={option.label} value={option.value}>{option.label}</option>
      ))}
    </select>
  );

  // Icon dimensions scale up in the prominent variant so the button reads as a
  // primary action in the top toolbar.
  const iconSize = isProminent ? "w-5 h-5" : "w-4 h-4";
  const waveBox = isProminent ? 20 : 16;

  const icon = isRecording ? (
    /* Animated waveform bars (sized to match the mic icon footprint) */
    <span className={`flex items-end justify-center gap-px ${iconSize}`}>
      {waveBars.map((h, i) => (
        <span
          key={i}
          className="w-0.5 bg-white rounded-sm transition-none"
          style={{ height: `${Math.round(h * waveBox)}px` }}
        />
      ))}
    </span>
  ) : (
    /* Mic icon */
    <svg className={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 0 1 -14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" strokeLinecap="round" />
      <line x1="8" y1="23" x2="16" y2="23" strokeLinecap="round" />
    </svg>
  );

  const commonButtonProps = {
    type: "button" as const,
    onClick: handleClick,
    onMouseDown: handlePointerDown,
    onMouseUp: handlePointerUp,
    onMouseLeave: handlePointerLeave,
    onTouchStart: handlePointerDown,
    onTouchEnd: handlePointerUp,
    disabled,
    title: isRecording ? "Stop dictation" : "Dictate a message (voice input)",
    "aria-label": isRecording ? "Stop dictation" : "Dictate a message",
    "aria-pressed": isRecording,
  };

  if (isProminent) {
    return (
      <div className="inline-flex items-center gap-1.5 shrink-0">
        <button
          {...commonButtonProps}
          className={[
            "shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium",
            "transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed",
            "focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-offset-transparent",
            isRecording
              ? "bg-red-600 hover:bg-red-700 text-white focus:ring-red-500 animate-pulse"
              : "bg-brand-600 hover:bg-brand-700 text-white focus:ring-brand-500",
          ].join(" ")}
        >
          {icon}
          <span>{isRecording ? "Listening..." : "Dictate"}</span>
        </button>
        {languageSelect}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5 shrink-0">
      <button
        {...commonButtonProps}
        className={[
          "shrink-0 p-2.5 rounded-xl transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed",
          isRecording
            ? "bg-red-600 hover:bg-red-700 text-white"
            : "bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300",
        ].join(" ")}
      >
        {icon}
      </button>
      {languageSelect}
    </div>
  );
});

ButlerVoiceButton.displayName = "ButlerVoiceButton";
