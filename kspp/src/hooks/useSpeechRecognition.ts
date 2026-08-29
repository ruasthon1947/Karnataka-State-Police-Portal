import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeAudio, type SttLanguage } from "../lib/speechApi";

type SpeechStatus = {
  transcript: string;
  interimTranscript: string;
  /** Accumulated finals + current interim — the single string to show as live caption */
  captionText: string;
  listening: boolean;
  starting: boolean;
  error: string;
  start: () => void;
  stop: () => void;
};

/**
 * Browser-independent speech recognition.
 *
 * Strategy:
 * 1. Try the Web Speech API (instant, local — works in Chrome / Edge).
 * 2. If no results arrive within FALLBACK_MS, switch to server-side STT
 *    (MediaRecorder → Groq Whisper).  This covers Brave, Firefox, Safari,
 *    and any environment where the Web Speech API is blocked or broken.
 * 3. If the Web Speech API doesn't exist at all, go straight to server STT.
 */

const FALLBACK_MS = 3_000; // Switch to server STT after this many ms with no results
const RESTART_DELAY_MS = 80; // Delay between Web Speech recognition restarts
const HEARTBEAT_MS = 6_000; // Force-restart if no activity for this long
const SERVER_CHUNK_MS = 1_000; // Send audio chunks to server every N ms
const MIN_CHUNK_BYTES = 200; // Skip tiny chunks

// ── helpers ──────────────────────────────────────────────────────────

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[],
    );
  }
  return btoa(binary);
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus"))
    return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  return "audio/ogg";
}

function langHint(lang: string): SttLanguage {
  return lang.startsWith("kn") ? "kn" : "en";
}

// ── hook ─────────────────────────────────────────────────────────────

export function useSpeechRecognition(lang: "kn-IN" | "en-IN"): SpeechStatus {
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [captionText, setCaptionText] = useState("");
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  // ── refs ──────────────────────────────────────────────────────────
  const recognitionRef = useRef<any>(null); // Web Speech instance
  const streamRef = useRef<MediaStream | null>(null); // Mic stream (server STT)
  const recorderRef = useRef<MediaRecorder | null>(null);
  const sendTimerRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fallbackTimerRef = useRef<number | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const modeRef = useRef<"web-speech" | "server-stt" | null>(null);
  const sendingRef = useRef(false);
  const manualStopRef = useRef(false);
  const webSpeechResultRef = useRef(false);
  const accumulatedRef = useRef("");
  const langRef = useRef(lang);

  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  // ── timer helpers ─────────────────────────────────────────────────

  const clearT = useCallback(
    (ref: React.MutableRefObject<number | null>) => {
      if (ref.current !== null) {
        clearTimeout(ref.current);
        ref.current = null;
      }
    },
    [],
  );

  const clearAllTimers = useCallback(() => {
    clearT(fallbackTimerRef);
    clearT(restartTimerRef);
    clearT(heartbeatTimerRef);
    clearT(sendTimerRef);
  }, [clearT]);

  // ── cleanup: Web Speech ───────────────────────────────────────────

  const destroyWebSpeech = useCallback(() => {
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* noop */ }
      recognitionRef.current = null;
    }
  }, []);

  // ── cleanup: Server STT ───────────────────────────────────────────

  const destroyServerSTT = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try { recorderRef.current.stop(); } catch { /* noop */ }
    }
    recorderRef.current = null;
    chunksRef.current = [];
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    sendingRef.current = false;
  }, []);

  const destroyAll = useCallback(() => {
    destroyWebSpeech();
    destroyServerSTT();
    clearAllTimers();
  }, [destroyWebSpeech, destroyServerSTT, clearAllTimers]);

  // ── shared state setters ──────────────────────────────────────────

  const applyFinal = useCallback((text: string) => {
    accumulatedRef.current +=
      (accumulatedRef.current ? " " : "") + text.trim();
    setTranscript(accumulatedRef.current);
  }, []);

  const applyLive = useCallback(
    (interim: string) => {
      const live =
        accumulatedRef.current +
        (interim
          ? (accumulatedRef.current ? " " : "") + interim
          : "");
      setCaptionText(live);
      setInterimTranscript(interim);
    },
    [],
  );

  // ══════════════════════════════════════════════════════════════════
  //  SERVER STT  (MediaRecorder → /api/speech-to-text → Groq Whisper)
  // ══════════════════════════════════════════════════════════════════

  const sendChunk = useCallback(async () => {
    if (
      chunksRef.current.length === 0 ||
      sendingRef.current ||
      manualStopRef.current
    )
      return;
    sendingRef.current = true;
    // MediaRecorder's later WebM chunks do not contain a container header.
    // Keep the complete recording so every request remains a valid file.
    const pending = [...chunksRef.current];

    try {
      const mimeType = recorderRef.current?.mimeType || pickMime();
      const blob = new Blob(pending, { type: mimeType });
      if (blob.size < MIN_CHUNK_BYTES) {
        sendingRef.current = false;
        return;
      }
      const buf = await blob.arrayBuffer();
      const audio = bufferToBase64(buf);
      const result = await transcribeAudio(
        audio,
        langHint(langRef.current),
        mimeType,
      );
      if (result.transcript.trim()) {
        setTranscript(result.transcript.trim());
        applyLive(result.transcript.trim());
      }
    } catch (err) {
      console.warn("[ServerSTT] chunk failed:", err);
      if (!manualStopRef.current) {
        setError("Live captions are unavailable. Check the speech service and try again.");
      }
    } finally {
      sendingRef.current = false;
    }
  }, [applyFinal, applyLive]);

  const startServerSTT = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;
    } catch {
      setError(
        "Microphone permission was denied. Allow microphone access and try again.",
      );
      setStarting(false);
      return;
    }

    const mimeType = pickMime();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(streamRef.current!, { mimeType });
    } catch {
      setError("Audio recording is not supported in this browser.");
      setStarting(false);
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && !manualStopRef.current)
        chunksRef.current.push(e.data);
    };
    recorder.onerror = () =>
      console.warn("[ServerSTT] MediaRecorder error");

    recorder.start(SERVER_CHUNK_MS);
    recorderRef.current = recorder;

    setStarting(false);
    setListening(true);

    // Send chunks at regular intervals
    sendTimerRef.current = window.setInterval(() => {
      void sendChunk();
    }, SERVER_CHUNK_MS);
  }, [sendChunk]);

  // ══════════════════════════════════════════════════════════════════
  //  WEB SPEECH API  (Chrome / Edge — instant local recognition)
  // ══════════════════════════════════════════════════════════════════

  const resetHeartbeat = useCallback(
    (rec: any) => {
      clearT(heartbeatTimerRef);
      heartbeatTimerRef.current = window.setTimeout(() => {
        if (recognitionRef.current === rec && !manualStopRef.current) {
          destroyWebSpeech();
          restartTimerRef.current = window.setTimeout(
            spawnWebSpeech,
            RESTART_DELAY_MS,
          );
        }
      }, HEARTBEAT_MS);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearT, destroyWebSpeech],
  );

  const spawnWebSpeech = useCallback(() => {
    if (manualStopRef.current || modeRef.current !== "web-speech") return;

    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) return;

    const rec = new SR();
    rec.lang = langRef.current;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setStarting(false);
      setListening(true);
      resetHeartbeat(rec);
    };

    rec.onresult = (event: any) => {
      webSpeechResultRef.current = true;
      clearT(fallbackTimerRef);
      let finals = "";
      let interims = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) finals += r[0].transcript;
        else interims += r[0].transcript;
      }
      if (finals.trim()) applyFinal(finals);
      applyLive(interims.trim());
      resetHeartbeat(rec);
    };

    rec.onerror = (event: any) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      console.error("[WebSpeech] error:", event.error);
      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed"
      ) {
        setError(
          "Microphone permission was denied. Allow microphone access and try again.",
        );
      }
    };

    rec.onend = () => {
      clearT(heartbeatTimerRef);
      if (
        manualStopRef.current ||
        modeRef.current !== "web-speech" ||
        recognitionRef.current !== rec
      )
        return;
      recognitionRef.current = null;
      restartTimerRef.current = window.setTimeout(
        spawnWebSpeech,
        RESTART_DELAY_MS,
      );
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch {
      recognitionRef.current = null;
      restartTimerRef.current = window.setTimeout(
        spawnWebSpeech,
        RESTART_DELAY_MS * 4,
      );
    }
  }, [applyFinal, applyLive, clearT, resetHeartbeat]);

  // ══════════════════════════════════════════════════════════════════
  //  START / STOP
  // ══════════════════════════════════════════════════════════════════

  const stop = useCallback(() => {
    manualStopRef.current = true;
    clearAllTimers();
    destroyAll();
    setListening(false);
    setStarting(false);
    setInterimTranscript("");
  }, [clearAllTimers, destroyAll]);

  const start = useCallback(async () => {
    // Reset everything
    manualStopRef.current = false;
    accumulatedRef.current = "";
    setTranscript("");
    setInterimTranscript("");
    setCaptionText("");
    setError("");
    setStarting(true);
    destroyAll();

    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (SR) {
      // ── Phase 1: try Web Speech API ──
      modeRef.current = "web-speech";
      webSpeechResultRef.current = false;
      spawnWebSpeech();

      // If no results arrive within FALLBACK_MS, switch to server STT
      fallbackTimerRef.current = window.setTimeout(async () => {
        if (
          manualStopRef.current ||
          webSpeechResultRef.current ||
          accumulatedRef.current !== "" ||
          modeRef.current !== "web-speech"
        )
          return;
        // Web Speech didn't produce results — fall back
        console.log("[SpeechRec] Web Speech produced no results, falling back to server STT");
        destroyWebSpeech();
        clearT(restartTimerRef);
        clearT(heartbeatTimerRef);
        modeRef.current = "server-stt";
        await startServerSTT();
      }, FALLBACK_MS);
    } else {
      // ── No Web Speech API → go straight to server STT ──
      modeRef.current = "server-stt";
      await startServerSTT();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destroyAll, spawnWebSpeech, destroyWebSpeech, clearT, startServerSTT]);

  // ── unmount cleanup ───────────────────────────────────────────────

  useEffect(
    () => () => {
      manualStopRef.current = true;
      destroyAll();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    transcript,
    interimTranscript,
    captionText,
    listening,
    starting,
    error,
    start,
    stop,
  };
}
