import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useLanguage } from "../../context/LanguageContext";
import { askCopilot } from "../../lib/chatApi";
import { KSPP_AVATAR_SRC } from "../../assets/kspp-avatar";

// The dedicated full-page AI Assistant lives at the root route ("/"), per
// AppShell.tsx's navigation config. The floating widget hides there so the
// user never sees two copilots stacked on one screen. Exact match (not
// startsWith) since startsWith("/") would match every route in the app.
const EXCLUDED_EXACT_PATHS = ["/"];

// Unicode range for the Kannada script — used to detect the actual
// language of a question's text, independent of any manual toggle.
const KANNADA_SCRIPT_RE = /[\u0C80-\u0CFF]/;

type WidgetState = "idle" | "listening" | "thinking" | "responding";
type SpokenLang = "en" | "kn";

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

// Default widget position, expressed as distance from the bottom-right
// corner of the viewport (matches the original fixed placement).
const DEFAULT_POSITION = { right: 24, bottom: 24 };

export const FloatingCopilot: React.FC = () => {
  const { language, tr } = useLanguage();
  const { user } = useAuth();
  const location = useLocation();

  const isExcludedRoute = EXCLUDED_EXACT_PATHS.includes(location.pathname);

  const [isOpen, setIsOpen] = useState(false);
  const [isTextMode, setIsTextMode] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [state, setState] = useState<WidgetState>("idle");
  const [answer, setAnswer] = useState<string | null>(null);
  const [askedQuestion, setAskedQuestion] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [wasVoiceQuery, setWasVoiceQuery] = useState(false);

  // Which language the mic should listen for. Defaults to the site's
  // current language but can be flipped independently per question.
  const [spokenLang, setSpokenLang] = useState<SpokenLang>(
    language === "kn" ? "kn" : "en",
  );

  // --- Draggable position -------------------------------------------------
  const [position, setPosition] = useState<{ right: number; bottom: number }>(
    DEFAULT_POSITION,
  );
  const dragState = useRef<{
    startX: number;
    startY: number;
    startRight: number;
    startBottom: number;
    dragging: boolean;
  } | null>(null);

  const onGripPointerDown = useCallback(
    (e: React.PointerEvent) => {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        startRight: position.right,
        startBottom: position.bottom,
        dragging: false,
      };
    },
    [position],
  );

  const onGripPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    if (!dragState.current.dragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      dragState.current.dragging = true;
    }
    if (!dragState.current.dragging) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nextRight = Math.min(
      Math.max(dragState.current.startRight - dx, 8),
      vw - 64,
    );
    const nextBottom = Math.min(
      Math.max(dragState.current.startBottom - dy, 8),
      vh - 64,
    );
    setPosition({ right: nextRight, bottom: nextBottom });
  }, []);

  const onGripPointerUp = useCallback((e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragState.current = null;
  }, []);
  // -------------------------------------------------------------------------

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const SpeechRecognitionCtor = useRef(getSpeechRecognition());

  // Setting utterance.lang alone ("en-IN"/"kn-IN") only picks a *locale*,
  // not necessarily an Indian-accented *voice* — many browsers still
  // default to a generic US/UK-accented voice for en-IN if that's the
  // first one loaded. Enumerating the actual installed voices and
  // explicitly selecting one that matches an Indian locale/name gets a
  // genuinely Indian-accented voice when the OS/browser has one available.
  // Note: which voices exist at all is entirely up to the user's OS and
  // browser voice packs — this picks the best match from what's installed,
  // it can't add a voice that isn't there. Kannada TTS voices in
  // particular are uncommon outside Chrome OS/Android; when none is
  // installed, English fallback pronunciation is used for Kannada text.
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const loadVoices = () => setVoices(window.speechSynthesis.getVoices());
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  const pickIndianVoice = useCallback(
    (lang: SpokenLang): SpeechSynthesisVoice | undefined => {
      const wantedPrefix = lang === "kn" ? "kn" : "en";
      const localeTag = lang === "kn" ? "kn-in" : "en-in";
      return (
        // Exact Indian locale match, e.g. "en-IN" / "kn-IN"
        voices.find((v) => v.lang.toLowerCase() === localeTag) ||
        // Any voice for the language whose lang/name flags it as Indian
        voices.find(
          (v) =>
            v.lang.toLowerCase().startsWith(wantedPrefix) &&
            (v.lang.toLowerCase().includes("in") || /india/i.test(v.name)),
        ) ||
        // Fall back to any voice at all for that language
        voices.find((v) => v.lang.toLowerCase().startsWith(wantedPrefix))
      );
    },
    [voices],
  );

  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    utteranceRef.current = null;
  }, []);

  const speak = useCallback(
    (text: string, lang: SpokenLang) => {
      if (isMuted) return;
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      stopSpeaking();
      // Strip markdown bold markers and emoji-ish bullets before speaking —
      // TTS engines read "**" and stray symbols aloud otherwise.
      const clean = text
        .replace(/\*\*/g, "")
        .replace(/[📌👤🚨⚠️]/g, "")
        .trim();
      if (!clean) return;
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = lang === "kn" ? "kn-IN" : "en-IN";
      const indianVoice = pickIndianVoice(lang);
      if (indianVoice) utterance.voice = indianVoice;
      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    },
    [isMuted, pickIndianVoice, stopSpeaking],
  );

  const submitQuestion = useCallback(
    async (question: string, viaVoice: boolean, voiceLangHint?: SpokenLang) => {
      const trimmed = question.trim();
      if (!trimmed) return;

      // For TYPED questions, detecting Kannada script in the text itself is
      // fully reliable — there's no misrecognition risk, so script
      // detection alone decides the response language.
      //
      // For VOICE questions, we deliberately do NOT rely on script
      // detection of the transcript. Browser speech recognition for kn-IN
      // isn't always reliable and can silently mis-transcribe Kannada
      // speech into English words or Latin-script romanization. If that
      // happens, script detection finds no Kannada characters in the
      // (already-wrong) transcript and would silently answer in English —
      // overriding the language the user explicitly chose on the mic
      // toggle before speaking. So for voice, we trust that explicit
      // toggle selection directly instead.
      const answerLang: SpokenLang = viaVoice
        ? voiceLangHint ?? "en"
        : KANNADA_SCRIPT_RE.test(trimmed)
          ? "kn"
          : "en";

      stopSpeaking();
      setErrorMsg(null);
      setAnswer(null);
      setAskedQuestion(trimmed);
      setWasVoiceQuery(viaVoice);
      setState("thinking");
      setIsOpen(true);

      try {
        const reply = await askCopilot({ question: trimmed, language: answerLang });
        setAnswer(reply);
        setState("responding");
        if (viaVoice) speak(reply, answerLang);
      } catch (err) {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : tr("Something went wrong. Please try again.", "ಏನೋ ತಪ್ಪಾಗಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ."),
        );
        setState("idle");
      }
    },
    [speak, stopSpeaking, tr],
  );

  // Tap to start, tap the same button again to stop — replaces the old
  // hold-to-talk pattern, which cancelled recognition almost immediately
  // on a normal click (mouseup fires right after mousedown) before any
  // speech could be captured. Recognition also still auto-stops on its own
  // after a pause in speech, same as before.
  const toggleListening = useCallback(() => {
    if (state === "listening") {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setState("idle");
      return;
    }

    const Ctor = SpeechRecognitionCtor.current;
    if (!Ctor) {
      setErrorMsg(
        tr(
          "Voice input isn't supported in this browser.",
          "ಈ ಬ್ರೌಸರ್‌ನಲ್ಲಿ ಧ್ವನಿ ಇನ್‌ಪುಟ್ ಬೆಂಬಲಿತವಾಗಿಲ್ಲ.",
        ),
      );
      return;
    }
    stopSpeaking();
    setErrorMsg(null);
    setAnswer(null);
    setAskedQuestion(null);
    setIsOpen(true);
    setState("listening");

    const recognition = new Ctor();
    recognition.lang = spokenLang === "kn" ? "kn-IN" : "en-IN";
    recognition.continuous = false;
    // Interim results let the widget show the transcript live, updating
    // word-by-word as the user talks — matching normal dictation UX —
    // instead of only revealing what was heard after speech ends.
    recognition.interimResults = true;

    recognition.onresult = (event: any) => {
      let combined = "";
      let isFinal = false;
      for (let i = 0; i < event.results.length; i += 1) {
        combined += event.results[i][0]?.transcript || "";
        if (event.results[i].isFinal) isFinal = true;
      }
      setAskedQuestion(combined);
      if (isFinal && combined.trim()) {
        void submitQuestion(combined, true, spokenLang);
      } else if (isFinal) {
        setState("idle");
      }
    };
    recognition.onerror = (event: any) => {
      const code = event?.error;
      const message =
        code === "not-allowed" || code === "permission-denied"
          ? tr(
              "Microphone access is blocked. Please allow it in your browser settings.",
              "ಮೈಕ್ರೊಫೋನ್ ಪ್ರವೇಶ ನಿರ್ಬಂಧಿಸಲಾಗಿದೆ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಬ್ರೌಸರ್ ಸೆಟ್ಟಿಂಗ್‌ಗಳಲ್ಲಿ ಅನುಮತಿಸಿ.",
            )
          : code === "no-speech"
            ? tr("Didn't catch that — try again.", "ಅದು ಕೇಳಿಸಲಿಲ್ಲ — ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.")
            : tr("Couldn't hear that. Please try again.", "ಅದು ಕೇಳಿಸಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.");
      setErrorMsg(message);
      setState("idle");
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setState((prev) => (prev === "listening" ? "idle" : prev));
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [spokenLang, state, stopSpeaking, submitQuestion, tr]);

  const closeCard = useCallback(() => {
    stopSpeaking();
    setAnswer(null);
    setAskedQuestion(null);
    setErrorMsg(null);
    setState("idle");
  }, [stopSpeaking]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      if (next) stopSpeaking();
      return next;
    });
  }, [stopSpeaking]);

  const handleTextSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const question = textInput;
      setTextInput("");
      void submitQuestion(question, false);
    },
    [submitQuestion, textInput],
  );

  // Keyboard shortcut: Ctrl/Cmd + K opens the text-input toggle, matching
  // the common command-palette convention used across the portal's other
  // search inputs.
  useEffect(() => {
    if (isExcludedRoute) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen(true);
        setIsTextMode(true);
      }
      if (e.key === "Escape" && isOpen) {
        closeCard();
        setIsTextMode(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeCard, isExcludedRoute, isOpen]);

  // Stop any in-flight speech when the component unmounts (logout, etc.)
  // so audio never keeps playing over a new page.
  useEffect(() => stopSpeaking, [stopSpeaking]);

  if (isExcludedRoute || !user) return null;

  const isListening = state === "listening";
  const isThinking = state === "thinking";
  const hasCard = state === "responding" || state === "listening" || errorMsg || isThinking;

  return (
    <div
      className="kspp-fc-root"
      style={{ right: position.right, bottom: position.bottom }}
      aria-live="polite"
    >
      <style>{`
        .kspp-fc-root {
          position: fixed;
          z-index: 9999;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 12px;
          font-family: inherit;
        }
        .kspp-fc-card {
          width: min(360px, calc(100vw - 48px));
          background: #14171f;
          color: #f2f4f8;
          border-radius: 16px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.08);
          padding: 16px 16px 14px;
          animation: kspp-fc-pop 160ms ease-out;
        }
        .dark .kspp-fc-card {
          background: #0e1016;
          border-color: rgba(255,255,255,0.1);
        }
        @keyframes kspp-fc-pop {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .kspp-fc-card-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        .kspp-fc-card-title {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: #9aa4b2;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .kspp-fc-card-actions {
          display: flex;
          gap: 6px;
        }
        .kspp-fc-iconbtn {
          background: rgba(255,255,255,0.06);
          border: none;
          color: #cfd6e2;
          width: 26px;
          height: 26px;
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          line-height: 1;
          transition: background 120ms ease;
        }
        .kspp-fc-iconbtn:hover { background: rgba(255,255,255,0.14); }
        .kspp-fc-card-body {
          font-size: 13.5px;
          line-height: 1.55;
          white-space: pre-wrap;
          max-height: 320px;
          overflow-y: auto;
        }
        .kspp-fc-card-body b { color: #ffffff; }
        .kspp-fc-error {
          color: #ff9b9b;
          font-size: 13px;
        }
        .kspp-fc-asked {
          display: flex;
          flex-direction: column;
          gap: 2px;
          background: rgba(255,255,255,0.05);
          border-left: 2px solid #2563eb;
          border-radius: 6px;
          padding: 6px 10px;
          margin-bottom: 10px;
        }
        .kspp-fc-asked-label {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: #6ea8fe;
        }
        .kspp-fc-asked-text {
          font-size: 12.5px;
          color: #cfd6e2;
          line-height: 1.4;
        }
        .kspp-fc-thinking {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #9aa4b2;
          font-size: 13px;
        }
        .kspp-fc-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #6ea8fe;
          animation: kspp-fc-blink 1.1s infinite ease-in-out;
        }
        .kspp-fc-dot:nth-child(2) { animation-delay: 0.15s; }
        .kspp-fc-dot:nth-child(3) { animation-delay: 0.3s; }
        @keyframes kspp-fc-blink {
          0%, 80%, 100% { opacity: 0.25; }
          40% { opacity: 1; }
        }
        .kspp-fc-textform {
          width: min(320px, calc(100vw - 48px));
          background: #14171f;
          border-radius: 14px;
          padding: 8px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.08);
          display: flex;
          gap: 6px;
          animation: kspp-fc-pop 160ms ease-out;
        }
        .kspp-fc-textform input {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: #f2f4f8;
          font-size: 13.5px;
          padding: 6px 8px;
        }
        .kspp-fc-textform input::placeholder { color: #6b7280; }
        .kspp-fc-textform button {
          background: #2563eb;
          border: none;
          color: white;
          border-radius: 10px;
          padding: 0 14px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .kspp-fc-dock {
          display: flex;
          align-items: center;
          gap: 8px;
          background: #14171f;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 999px;
          padding: 6px 10px 6px 6px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.3);
        }
        .kspp-fc-grip {
          width: 18px;
          height: 34px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #5b6472;
          cursor: grab;
          font-size: 14px;
          touch-action: none;
          user-select: none;
          flex-shrink: 0;
        }
        .kspp-fc-grip:active { cursor: grabbing; color: #9aa4b2; }
        .kspp-fc-avatar-btn {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.12);
          overflow: hidden;
          padding: 0;
          cursor: pointer;
          background: #0e1016;
          flex-shrink: 0;
          position: relative;
        }
        .kspp-fc-avatar-btn img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .kspp-fc-avatar-btn.listening {
          border-color: #ef4444;
          box-shadow: 0 0 0 4px rgba(239,68,68,0.18);
          animation: kspp-fc-glow 1.2s infinite ease-in-out;
        }
        @keyframes kspp-fc-glow {
          0%, 100% { box-shadow: 0 0 0 3px rgba(239,68,68,0.15); }
          50% { box-shadow: 0 0 0 8px rgba(239,68,68,0.06); }
        }
        .kspp-fc-status {
          font-size: 11.5px;
          font-weight: 700;
          letter-spacing: 0.03em;
          color: #ef4444;
          display: flex;
          align-items: center;
          gap: 5px;
          padding-right: 4px;
          cursor: pointer;
        }
        .kspp-fc-status .kspp-fc-livedot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #ef4444;
          animation: kspp-fc-blink 0.9s infinite ease-in-out;
        }
        .kspp-fc-dockbtn {
          width: 34px;
          height: 34px;
          border-radius: 50%;
          border: none;
          background: rgba(255,255,255,0.06);
          color: #cfd6e2;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          transition: background 120ms ease;
        }
        .kspp-fc-dockbtn:hover { background: rgba(255,255,255,0.14); }
        .kspp-fc-langpill {
          display: flex;
          border-radius: 999px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,0.1);
          flex-shrink: 0;
        }
        .kspp-fc-langpill button {
          border: none;
          background: transparent;
          color: #8b94a3;
          font-size: 10.5px;
          font-weight: 700;
          padding: 6px 8px;
          cursor: pointer;
        }
        .kspp-fc-langpill button.active {
          background: #2563eb;
          color: white;
        }
        @media (max-width: 480px) {
          .kspp-fc-root { right: 12px !important; bottom: 12px !important; }
        }
      `}</style>

      {hasCard && (
        <div className="kspp-fc-card" role="status">
          <div className="kspp-fc-card-head">
            <span className="kspp-fc-card-title">
              🛡 {tr("KSPP Copilot", "KSPP ಸಹಾಯಕ")}
            </span>
            <div className="kspp-fc-card-actions">
              {state === "responding" && !errorMsg && (
                <button
                  type="button"
                  className="kspp-fc-iconbtn"
                  onClick={() => {
                    if (typeof window !== "undefined" && window.speechSynthesis?.speaking) {
                      stopSpeaking();
                    } else if (answer) {
                      speak(answer, KANNADA_SCRIPT_RE.test(answer) ? "kn" : "en");
                    }
                  }}
                  title={tr("Play / stop audio", "ಆಡಿಯೋ ಪ್ಲೇ / ನಿಲ್ಲಿಸಿ")}
                  aria-label={tr("Play or stop audio response", "ಆಡಿಯೋ ಪ್ರತಿಕ್ರಿಯೆಯನ್ನು ಪ್ಲೇ ಅಥವಾ ನಿಲ್ಲಿಸಿ")}
                >
                  {isMuted ? "🔇" : "🔊"}
                </button>
              )}
              <button
                type="button"
                className="kspp-fc-iconbtn"
                onClick={closeCard}
                title={tr("Close", "ಮುಚ್ಚಿ")}
                aria-label={tr("Close response", "ಪ್ರತಿಕ್ರಿಯೆಯನ್ನು ಮುಚ್ಚಿ")}
              >
                ✕
              </button>
            </div>
          </div>

          {askedQuestion && (
            <div className="kspp-fc-asked">
              <span className="kspp-fc-asked-label">
                {isListening ? tr("Listening", "ಆಲಿಸಲಾಗುತ್ತಿದೆ") : tr("You asked", "ನೀವು ಕೇಳಿದ್ದು")}
              </span>
              <span className="kspp-fc-asked-text">{askedQuestion}</span>
            </div>
          )}

          {isThinking && (
            <div className="kspp-fc-thinking">
              <span className="kspp-fc-dot" />
              <span className="kspp-fc-dot" />
              <span className="kspp-fc-dot" />
              {tr("Checking records...", "ದಾಖಲೆಗಳನ್ನು ಪರಿಶೀಲಿಸಲಾಗುತ್ತಿದೆ...")}
            </div>
          )}

          {errorMsg && !isThinking && <div className="kspp-fc-error">{errorMsg}</div>}

          {answer && !isThinking && !errorMsg && (
            <div
              className="kspp-fc-card-body"
              dangerouslySetInnerHTML={{
                __html: answer
                  .replace(/&/g, "&amp;")
                  .replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;")
                  .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
                  .replace(/\n/g, "<br/>"),
              }}
            />
          )}
        </div>
      )}

      {isTextMode && (
        <form className="kspp-fc-textform" onSubmit={handleTextSubmit}>
          <input
            autoFocus
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder={tr(
              "Type a question — crime number, station, complainant...",
              "ಪ್ರಶ್ನೆಯನ್ನು ಟೈಪ್ ಮಾಡಿ — ಅಪರಾಧ ಸಂಖ್ಯೆ, ಠಾಣೆ, ದೂರುದಾರ...",
            )}
          />
          <button type="submit">{tr("Ask", "ಕೇಳಿ")}</button>
        </form>
      )}

      <div className="kspp-fc-dock">
        <div
          className="kspp-fc-grip"
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerUp}
          title={tr("Drag to move", "ಸರಿಸಲು ಎಳೆಯಿರಿ")}
          aria-hidden="true"
        >
          ⠿
        </div>

        <button
          type="button"
          className={`kspp-fc-avatar-btn${isListening ? " listening" : ""}`}
          onClick={toggleListening}
          title={
            isListening
              ? tr("Tap to stop", "ನಿಲ್ಲಿಸಲು ಟ್ಯಾಪ್ ಮಾಡಿ")
              : tr("Tap to talk", "ಮಾತನಾಡಲು ಟ್ಯಾಪ್ ಮಾಡಿ")
          }
          aria-label={tr("Talk to the Copilot", "ಸಹಾಯಕದೊಂದಿಗೆ ಮಾತನಾಡಿ")}
        >
          <img src={KSPP_AVATAR_SRC} alt="" />
        </button>

        {isListening ? (
          <span
            className="kspp-fc-status"
            onClick={toggleListening}
            title={tr("Tap to stop listening", "ಆಲಿಸುವುದನ್ನು ನಿಲ್ಲಿಸಲು ಟ್ಯಾಪ್ ಮಾಡಿ")}
          >
            <span className="kspp-fc-livedot" />
            {tr("LISTENING...", "ಆಲಿಸಲಾಗುತ್ತಿದೆ...")}
          </span>
        ) : (
          <>
            <div className="kspp-fc-langpill" title={tr("Mic language", "ಮೈಕ್ ಭಾಷೆ")}>
              <button
                type="button"
                className={spokenLang === "en" ? "active" : ""}
                onClick={() => setSpokenLang("en")}
              >
                EN
              </button>
              <button
                type="button"
                className={spokenLang === "kn" ? "active" : ""}
                onClick={() => setSpokenLang("kn")}
              >
                ಕನ್ನಡ
              </button>
            </div>
            <button
              type="button"
              className="kspp-fc-dockbtn"
              onClick={() => setIsTextMode((v) => !v)}
              title={tr(
                "Type a question instead of speaking",
                "ಮಾತನಾಡುವ ಬದಲು ಪ್ರಶ್ನೆಯನ್ನು ಟೈಪ್ ಮಾಡಿ",
              )}
              aria-label={tr("Toggle text input", "ಪಠ್ಯ ಇನ್‌ಪುಟ್ ಟಾಗಲ್ ಮಾಡಿ")}
            >
              ⌨
            </button>
            <button
              type="button"
              className="kspp-fc-dockbtn"
              onClick={toggleMute}
              title={tr("Mute voice responses", "ಧ್ವನಿ ಪ್ರತಿಕ್ರಿಯೆಗಳನ್ನು ಮ್ಯೂಟ್ ಮಾಡಿ")}
              aria-label={tr("Toggle mute", "ಮ್ಯೂಟ್ ಟಾಗಲ್ ಮಾಡಿ")}
            >
              {isMuted ? "🔇" : "🔊"}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default FloatingCopilot;
