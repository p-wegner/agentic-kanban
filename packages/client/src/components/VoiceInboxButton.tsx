import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface VoiceInboxButtonProps {
  projectId: string | null;
  onIssueCreated?: () => void;
}

type RecordingState = "idle" | "recording" | "processing";

// Web Speech API types (may not be in all TS lib versions)
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
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

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionType;
    webkitSpeechRecognition?: new () => SpeechRecognitionType;
  }
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionType) | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export function VoiceInboxButton({ projectId, onIssueCreated }: VoiceInboxButtonProps) {
  const [state, setState] = useState<RecordingState>("idle");
  const [interimText, setInterimText] = useState("");
  const recognitionRef = useRef<SpeechRecognitionType | null>(null);
  const transcriptRef = useRef<string>("");

  // Animated waveform bars (3 bars, sine-wave phase offset)
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

  const submitTranscript = useCallback(async (transcript: string) => {
    if (!projectId || !transcript.trim()) {
      setState("idle");
      return;
    }
    setState("processing");
    try {
      const result = await apiFetch<{ issueId: string; issueNumber: number; title: string }>(
        `/api/projects/${projectId}/voice-capture`,
        {
          method: "POST",
          body: JSON.stringify({ transcript }),
        },
      );
      showToast(`🎙️ Created #${result.issueNumber}: ${result.title}`, "success");
      onIssueCreated?.();
    } catch (err: any) {
      showToast(`Voice capture failed: ${err.message}`, "error");
    } finally {
      setState("idle");
      setInterimText("");
      transcriptRef.current = "";
    }
  }, [projectId, onIssueCreated]);

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
  }, []);

  const startRecording = useCallback(() => {
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) {
      showToast("Voice capture requires a browser with Web Speech API (Chrome/Edge)", "error");
      return;
    }

    transcriptRef.current = "";
    setInterimText("");

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      // Start from event.resultIndex so we only process NEW results.
      // event.results is cumulative (contains all results from session start),
      // so iterating from 0 would re-append previously-finalized text on each event.
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          transcriptRef.current += res[0].transcript + " ";
        } else {
          interim += res[0].transcript;
        }
      }
      setInterimText(interim);
    };

    recognition.onerror = () => {
      const captured = transcriptRef.current.trim();
      recognitionRef.current = null;
      if (captured) {
        void submitTranscript(captured);
      } else {
        setState("idle");
        setInterimText("");
      }
    };

    recognition.onend = () => {
      const captured = transcriptRef.current.trim();
      recognitionRef.current = null;
      if (captured) {
        void submitTranscript(captured);
      } else {
        setState("idle");
        setInterimText("");
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setState("recording");
  }, [submitTranscript]);

  const handleClick = useCallback(() => {
    if (!projectId) return;
    if (state === "idle") {
      startRecording();
    } else if (state === "recording") {
      stopRecording();
    }
    // processing state: ignore clicks
  }, [state, projectId, startRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
    };
  }, []);

  // Listen for the global trigger event (fired by the shift+v shortcut in BoardPage)
  useEffect(() => {
    function onTrigger() {
      if (state === "idle" && projectId) startRecording();
    }
    window.addEventListener("voice-inbox-trigger", onTrigger);
    return () => window.removeEventListener("voice-inbox-trigger", onTrigger);
  }, [state, projectId, startRecording]);

  const isRecording = state === "recording";
  const isProcessing = state === "processing";
  const isDisabled = !projectId || isProcessing;

  const title = isRecording
    ? "Recording… click to stop and create issue"
    : isProcessing
    ? "Processing voice note…"
    : "Voice inbox — record an idea and auto-create a Backlog issue (shift+v)";

  return (
    <div className="relative shrink-0">
      <button
        onClick={handleClick}
        disabled={isDisabled}
        title={title}
        className={[
          "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors",
          isRecording
            ? "bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900"
            : isProcessing
            ? "bg-violet-50 dark:bg-violet-950 border-violet-200 dark:border-violet-800 text-violet-600 dark:text-violet-400 opacity-80 cursor-wait"
            : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed",
        ].join(" ")}
      >
        {isProcessing ? (
          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
        ) : isRecording ? (
          /* Animated waveform bars */
          <span className="flex items-end gap-px h-3.5">
            {waveBars.map((h, i) => (
              <span
                key={i}
                className="w-0.5 bg-red-500 rounded-sm transition-none"
                style={{ height: `${Math.round(h * 14)}px` }}
              />
            ))}
          </span>
        ) : (
          /* Mic icon */
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" strokeLinecap="round" />
            <line x1="8" y1="23" x2="16" y2="23" strokeLinecap="round" />
          </svg>
        )}
        {isProcessing ? "Processing…" : isRecording ? "Stop" : "Voice"}
      </button>
      {/* Interim transcript tooltip */}
      {isRecording && interimText && (
        <div className="absolute top-full left-0 mt-1 z-50 max-w-xs bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs rounded-md px-2.5 py-1.5 shadow-lg pointer-events-none">
          <span className="italic opacity-75">{interimText}</span>
        </div>
      )}
    </div>
  );
}
