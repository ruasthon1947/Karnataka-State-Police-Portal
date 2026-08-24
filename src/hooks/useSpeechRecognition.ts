import { useCallback, useEffect, useRef, useState } from "react";

type SpeechStatus = {
  transcript: string;
  interimTranscript: string;
  listening: boolean;
  starting: boolean;
  error: string;
  start: () => void;
  stop: () => void;
};

export function useSpeechRecognition(lang: "kn-IN" | "en-IN"): SpeechStatus {
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const recognitionRef = useRef<any>(null);
  const timeoutRef = useRef<number | null>(null);

  const clearAutoStop = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearAutoStop();
    try {
      recognitionRef.current?.stop();
    } catch {
      // Recognition may already be stopping.
    }
    setListening(false);
    setStarting(false);
    setInterimTranscript("");
  }, [clearAutoStop]);

  useEffect(() => {
    if (recognitionRef.current) recognitionRef.current.lang = lang;
  }, [lang]);

  const start = useCallback(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setError("Microphone input is not supported here. Please use Chrome or Edge.");
      return;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Ignore stale recognition cleanup errors.
      }
      recognitionRef.current = null;
    }

    setTranscript("");
    setInterimTranscript("");
    setError("");
    setStarting(true);

    const recognition = new SpeechRecognition();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setStarting(false);
      setListening(true);
    };

    recognition.onresult = (event: any) => {
      let finalText = "";
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      setInterimTranscript(interimText.trim());
      if (finalText.trim()) {
        setTranscript(finalText.trim());
        setInterimTranscript("");
      }
    };

    recognition.onspeechend = () => {
      try {
        recognition.stop();
      } catch {
        // Recognition may already be stopping.
      }
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error:", event.error);
      const message =
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "Microphone permission was denied. Allow microphone access and try again."
          : event.error === "no-speech"
            ? "No speech was detected. Please try again."
            : "Microphone recognition failed. Please try again.";
      setError(message);
      stop();
    };

    recognition.onend = () => {
      clearAutoStop();
      setListening(false);
      setStarting(false);
      setInterimTranscript("");
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      timeoutRef.current = window.setTimeout(stop, 15_000);
    } catch (startError) {
      console.error("Failed to start speech recognition:", startError);
      setError("The microphone could not be started. Please try again.");
      setStarting(false);
    }
  }, [clearAutoStop, lang, stop]);

  useEffect(() => () => stop(), [stop]);

  return {
    transcript,
    interimTranscript,
    listening,
    starting,
    error,
    start,
    stop,
  };
}
