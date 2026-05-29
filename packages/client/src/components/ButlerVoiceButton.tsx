import { useCallback, useEffect, useRef, useState } from "react";
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
}

type RecordingState = "idle" | "recording";

// Web Speech API types (may not be in all TS lib versions). Mirrors the
// declarations in VoiceInboxButton.tsx — kept local so the two voice features
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

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionType) | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/**
 * Microphone button for the butler chat input. Dictates speech into the
 * message textarea (via {@link ButlerVoiceButtonProps.onTranscript}) instead
 * of auto-sending, so the user can edit before submitting. Click to start,
 * click again to stop.
 */
export function ButlerVoiceButton({ disabled, onTranscript, onInterim }: ButlerVoiceButtonProps) {
  const [state, setState] = useState<RecordingState>("idle");
  const recognitionRef = useRef<SpeechRecognitionType | null>(null);

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

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    onInterim?.("");
    setState("idle");
  }, [onInterim]);

  const startRecording = useCallback(() => {
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) {
      showToast("Voice input requires a browser with Web Speech API (Chrome/Edge)", "error");
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      // Start from event.resultIndex so we only process NEW results.
      // event.results is cumulative (contains all results from session start),
      // so iterating from 0 would re-append previously-finalized text.
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          onTranscript(res[0].transcript.trim() + " ");
        } else {
          interim += res[0].transcript;
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
      recognitionRef.current = null;
      onInterim?.("");
      setState("idle");
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      onInterim?.("");
      setState("idle");
    };

    recognitionRef.current = recognition;
    recognition.start();
    setState("recording");
  }, [onTranscript, onInterim]);

  const handleClick = useCallback(() => {
    if (state === "idle") {
      startRecording();
    } else {
      stopRecording();
    }
  }, [state, startRecording, stopRecording]);

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

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={isRecording ? "Stop dictation" : "Dictate a message (voice input)"}
      aria-label={isRecording ? "Stop dictation" : "Dictate a message"}
      aria-pressed={isRecording}
      className={[
        "shrink-0 p-2.5 rounded-xl transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed",
        isRecording
          ? "bg-red-600 hover:bg-red-700 text-white"
          : "bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300",
      ].join(" ")}
    >
      {isRecording ? (
        /* Animated waveform bars (4×4 box to match the send icon footprint) */
        <span className="flex items-end justify-center gap-px w-4 h-4">
          {waveBars.map((h, i) => (
            <span
              key={i}
              className="w-0.5 bg-white rounded-sm transition-none"
              style={{ height: `${Math.round(h * 16)}px` }}
            />
          ))}
        </span>
      ) : (
        /* Mic icon */
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" strokeLinecap="round" />
          <line x1="8" y1="23" x2="16" y2="23" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
