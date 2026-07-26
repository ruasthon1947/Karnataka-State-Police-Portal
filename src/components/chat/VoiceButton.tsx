import React, { useEffect, useRef } from "react";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition";

type Props = {
  language: "en" | "kn";
  onResult: (text: string) => void;
  disabled?: boolean;
};

export const VoiceButton: React.FC<Props> = ({ language, onResult, disabled = false }) => {
  // Map "kn" to "kn-IN" and "en" to "en-IN"
  const langCode = language === "kn" ? "kn-IN" : "en-IN";
  
  // Pass dynamic langCode down to the hook
  const {
    listening,
    starting,
    error,
    interimTranscript,
    start,
    stop,
    transcript,
  } = useSpeechRecognition(langCode);

  // Keep a stable ref to onResult to prevent useEffect dependency loops
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    if (transcript && transcript.trim() !== "") {
      // 🚀 Dispatch result once
      onResultRef.current(transcript);
    }
  }, [transcript]); // ONLY depend on transcript!

  const active = listening || starting;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={active ? stop : start}
        disabled={disabled}
        aria-pressed={active}
        aria-label={active ? "Stop listening" : "Start voice input"}
        title={active ? "Stop listening" : "Speak your question"}
        className={`h-8 w-8 shrink-0 grid place-items-center rounded-md transition disabled:opacity-40 ${
          active
            ? "bg-red-500 text-white animate-pulse ring-2 ring-red-400/40"
            : "text-muted hover:text-white hover:bg-panel"
        }`}
      >
        🎤
      </button>
      {active && (
        <span className="max-w-40 truncate text-xs font-medium text-red-300" role="status">
          {starting ? "Starting microphone…" : interimTranscript || "Listening…"}
        </span>
      )}
      {!active && error && (
        <span className="max-w-56 text-xs text-red-300" role="alert">{error}</span>
      )}
    </div>
  );
};

