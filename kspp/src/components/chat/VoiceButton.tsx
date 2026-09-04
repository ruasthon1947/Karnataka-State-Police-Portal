import React, { useEffect, useRef } from "react";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition";

type Props = {
  language: "en" | "kn";
  onResult: (text: string) => void;
  disabled?: boolean;
  /** Receives the flowing live-caption text (accumulated finals + interim) */
  onLiveTranscript?: (text: string) => void;
};

export const VoiceButton: React.FC<Props> = ({
  language,
  onResult,
  disabled = false,
  onLiveTranscript,
}) => {
  const langCode = language === "kn" ? "kn-IN" : "en-IN";

  const {
    listening,
    starting,
    error,
    captionText,
    start,
    stop,
    transcript,
  } = useSpeechRecognition(langCode);
  const active = listening || starting;

  // Stable refs so useEffect doesn't loop
  const onResultRef = useRef(onResult);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);
  const onLiveRef = useRef(onLiveTranscript);
  useEffect(() => { onLiveRef.current = onLiveTranscript; }, [onLiveTranscript]);

  // Forward every captionText change to the parent as live captions
  useEffect(() => {
    onLiveRef.current?.(captionText);
  }, [captionText]);

  // Dispatch the complete utterance only when the user stops recording.
  // Web Speech can emit final phrases during a pause while the user is
  // still speaking, so dispatching on every transcript update submits early.
  useEffect(() => {
    if (!active && transcript.trim() !== "") {
      onResultRef.current(transcript);
    }
  }, [active, transcript]);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={active ? stop : start}
        disabled={disabled}
        aria-pressed={active}
        aria-label={active ? (language === "kn" ? "ಆಲಿಸುವುದನ್ನು ನಿಲ್ಲಿಸಿ" : "Stop listening") : (language === "kn" ? "ಧ್ವನಿ ಇನ್‌ಪುಟ್ ಪ್ರಾರಂಭಿಸಿ" : "Start voice input")}
        title={active ? (language === "kn" ? "ಆಲಿಸುವುದನ್ನು ನಿಲ್ಲಿಸಿ" : "Stop listening") : (language === "kn" ? "ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಹೇಳಿ" : "Speak your question")}
        className={`h-8 w-8 shrink-0 grid place-items-center rounded-md transition disabled:opacity-40 ${active
            ? "bg-red-500 text-white animate-pulse ring-2 ring-red-400/40"
            : "text-muted hover:text-white hover:bg-panel"
          }`}
      >
        🎤
      </button>
      {active && (
        <span className="max-w-56 truncate text-xs font-semibold text-slate-900 dark:text-slate-100" role="status">
          {starting
            ? (language === "kn" ? "ಮೈಕ್ರೊಫೋನ್ ಪ್ರಾರಂಭವಾಗುತ್ತಿದೆ…" : "Starting microphone…")
            : captionText || (language === "kn" ? "ಆಲಿಸಲಾಗುತ್ತಿದೆ…" : "Listening…")}
        </span>
      )}
      {!active && error && (
        <span className="max-w-56 text-xs text-red-600 dark:text-red-400" role="alert">{language === "kn" ? "ಧ್ವನಿ ಇನ್‌ಪುಟ್ ಲಭ್ಯವಿಲ್ಲ. ಮೈಕ್ರೊಫೋನ್ ಅನುಮತಿಯನ್ನು ಪರಿಶೀಲಿಸಿ." : error}</span>
      )}
    </div>
  );
};










