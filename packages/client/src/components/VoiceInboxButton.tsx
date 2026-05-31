import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";
import {
  getVoiceLanguageLabel,
  loadVoiceLanguage,
  resolveVoiceLanguage,
  saveVoiceLanguage,
  VOICE_LANGUAGE_OPTIONS,
} from "../lib/voice-language.js";
import { showToast } from "./Toast.js";

interface VoiceInboxButtonProps {
  projectId: string | null;
  onIssueCreated?: () => void;
}

type RecordingState = "idle" | "recording" | "review" | "processing";
type VoiceCaptureResult =
  | { type: "issue"; issueId: string; issueNumber: number; title: string }
  | { type: "action"; action: "move_issue"; issueId: string; issueNumber: number; title: string; targetStatus: string; message: string };

// Web Speech API types (may not be in all TS lib versions)
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
  const [voiceLanguage, setVoiceLanguage] = useState(loadVoiceLanguage);
  // Editable transcript shown in the review dialog after recording stops.
  const [reviewText, setReviewText] = useState("");
  const recognitionRef = useRef<SpeechRecognitionType | null>(null);
  const transcriptRef = useRef<string>("");
  // Set when the user cancels mid-recording so the onend/onerror handler skips
  // the review step and discards the captured transcript.
  const cancelledRef = useRef(false);

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
    const speechRecognitionLanguage = resolveVoiceLanguage(voiceLanguage);
    setState("processing");
    try {
      const result = await apiFetch<VoiceCaptureResult>(
        `/api/projects/${projectId}/voice-capture`,
        {
          method: "POST",
          body: JSON.stringify({
            transcript,
            speechLanguage: speechRecognitionLanguage || null,
            speechLanguageLabel: getVoiceLanguageLabel(speechRecognitionLanguage),
          }),
        },
      );
      if (result.type === "action") {
        showToast(result.message, "success");
        onIssueCreated?.();
      } else {
        showToast(`Created #${result.issueNumber}: ${result.title}`, "success");
        onIssueCreated?.();
      }
    } catch (err: any) {
      showToast(`Voice capture failed: ${err.message}`, "error");
    } finally {
      setState("idle");
      setInterimText("");
      setReviewText("");
      transcriptRef.current = "";
    }
  }, [projectId, onIssueCreated, voiceLanguage]);

  // Stop listening and move to the review step (does NOT create an issue yet —
  // the captured transcript is surfaced for the user to confirm, edit or discard).
  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
  }, []);

  // Abort recording and discard everything captured, returning to the ready state.
  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
    transcriptRef.current = "";
    setInterimText("");
    setReviewText("");
    setState("idle");
  }, []);

  // Confirm the reviewed transcript → create the issue.
  const confirmReview = useCallback(() => {
    void submitTranscript(reviewText);
  }, [submitTranscript, reviewText]);

  // Discard the reviewed transcript without creating an issue.
  const discardReview = useCallback(() => {
    transcriptRef.current = "";
    setReviewText("");
    setInterimText("");
    setState("idle");
  }, []);

  const startRecording = useCallback(() => {
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) {
      showToast("Voice capture requires a browser with Web Speech API (Chrome/Edge)", "error");
      return;
    }

    transcriptRef.current = "";
    cancelledRef.current = false;
    setInterimText("");
    setReviewText("");

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    const recognitionLanguage = resolveVoiceLanguage(voiceLanguage);
    if (recognitionLanguage) {
      recognition.lang = recognitionLanguage;
    }

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

    // Both onerror and onend route to the review step instead of auto-submitting,
    // so the user always gets a chance to confirm/edit/discard before an issue is
    // created. cancelledRef short-circuits this when the user explicitly aborted.
    const finishToReview = () => {
      recognitionRef.current = null;
      setInterimText("");
      if (cancelledRef.current) {
        cancelledRef.current = false;
        transcriptRef.current = "";
        setReviewText("");
        setState("idle");
        return;
      }
      const captured = transcriptRef.current.trim();
      if (captured) {
        setReviewText(captured);
        setState("review");
      } else {
        setState("idle");
      }
    };

    recognition.onerror = finishToReview;
    recognition.onend = finishToReview;

    recognitionRef.current = recognition;
    recognition.start();
    setState("recording");
  }, [submitTranscript, voiceLanguage]);

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
  const isReviewing = state === "review";
  const isProcessing = state === "processing";
  const isDisabled = !projectId || isProcessing || isReviewing;
  const isLanguageDisabled = isDisabled || isRecording;

  const title = isRecording
    ? "Recording… click to stop and review before submitting"
    : isProcessing
    ? "Processing voice note…"
    : isReviewing
    ? "Review the transcript before creating an issue or running a command"
    : "Voice inbox — record an idea or quick board command (shift+v)";

  return (
    <div className="relative shrink-0 inline-flex items-center gap-1">
      <button
        onClick={handleClick}
        disabled={isDisabled}
        title={title}
        className={[
          "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors",
          isRecording
            ? "bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900"
            : isProcessing
            ? "bg-brand-50 dark:bg-brand-900/40 border-brand-200 dark:border-brand-700 text-brand-600 dark:text-brand-400 opacity-80 cursor-wait"
            : "bg-surface-raised dark:bg-surface-raised-dark border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed",
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

      <select
        value={voiceLanguage}
        onChange={(e) => setVoiceLanguage(saveVoiceLanguage(e.target.value))}
        disabled={isLanguageDisabled}
        aria-label="Voice input language"
        title="Voice input language"
        className="h-7 max-w-[116px] rounded-md border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark px-1.5 text-xs text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {VOICE_LANGUAGE_OPTIONS.map((option) => (
          <option key={option.label} value={option.value}>{option.label}</option>
        ))}
      </select>

      {/* Cancel (abort) button — only while recording. Discards the capture
          without creating an issue, returning straight to the ready state. */}
      {isRecording && (
        <button
          onClick={cancelRecording}
          title="Cancel recording (discard)"
          aria-label="Cancel recording"
          className="ml-1 inline-flex items-center justify-center w-6 h-6 rounded-md border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark text-gray-500 dark:text-gray-400 hover:text-red-600 hover:border-red-300 dark:hover:text-red-400 dark:hover:border-red-700 transition-colors align-middle"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <line x1="6" y1="6" x2="18" y2="18" strokeLinecap="round" />
            <line x1="18" y1="6" x2="6" y2="18" strokeLinecap="round" />
          </svg>
        </button>
      )}

      {/* Interim transcript tooltip */}
      {isRecording && interimText && (
        <div className="absolute top-full left-0 mt-1 z-50 max-w-xs bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs rounded-md px-2.5 py-1.5 shadow-lg pointer-events-none">
          <span className="italic opacity-75">{interimText}</span>
        </div>
      )}

      {/* Post-recording confirmation dialog — review/edit the transcript before
          an issue is created. Cancelling discards it. */}
      {isReviewing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-lg border border-gray-200 dark:border-gray-700">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Review voice input</h2>
              <button
                onClick={discardReview}
                aria-label="Discard"
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1 rounded"
              >
                ✕
              </button>
            </div>

            <div className="p-4 space-y-3">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Review the transcribed text below. Commands like "move #10 to review" run directly;
                other notes create an issue.
              </p>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block">Transcript</label>
              <textarea
                value={reviewText}
                onChange={(e) => setReviewText(e.target.value)}
                rows={8}
                autoFocus
                placeholder="Transcribed text…"
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-800 dark:text-gray-100 resize-y"
              />
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={discardReview}
                className="text-sm px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              >
                Discard
              </button>
              <button
                onClick={confirmReview}
                disabled={!reviewText.trim()}
                className="text-sm px-3 py-1.5 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50"
              >
                Submit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
