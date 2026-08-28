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

// Voice-name patterns for the highest-quality natural voices, checked
// before falling back to generic locale matching. These are the specific
// engines known to sound natural rather than robotic, when installed.
const PREFERRED_VOICE_NAME_PATTERNS: Record<SpokenLang, RegExp[]> = {
  en: [
    /neerja/i,
    /prabhat/i,
    /google.*english.*india/i,
    /english.*india/i,
    /india.*english/i
  ],
  kn: [
    /sapna/i,
    /kannada/i,
    /google.*ಕನ್ನಡ/i,
    /ಕನ್ನಡ/
  ],
};

// Google Translate's public TTS endpoint rejects queries much beyond ~200
// characters, so longer answers must be split into smaller chunks and
// played back-to-back. 160 chars leaves comfortable headroom under that
// limit even after URL-encoding.
const GOOGLE_TTS_MAX_CHARS = 160;

// A slightly sub-1.0 rate reads as noticeably more natural than the
// browser's default (which many engines set to a fast, robotic cadence).
// 0.95 sits comfortably within the 0.9–1.0 band that avoids the
// "too fast, too staccato" problem while keeping answers brisk.
const NATURAL_SPEECH_RATE = 0.95;

// Split long answers into streamable chunks for Google Translate TTS.
// Breaks at the last sentence/punctuation boundary within the limit so
// words are never cut mid-syllable. Includes the Kannada danda (। ॥) so
// Kannada text breaks at natural pauses too.
function chunkTextForGoogleTts(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    if (remaining.length <= GOOGLE_TTS_MAX_CHARS) {
      chunks.push(remaining);
      break;
    }
    let cut = -1;
    const boundaries = ["।", "॥", ".", "!", "?"];
    for (const b of boundaries) {
      const idx = remaining.lastIndexOf(b, GOOGLE_TTS_MAX_CHARS);
      if (idx > cut) cut = idx;
    }
    if (cut <= 0) {
      // No sentence boundary in range — fall back to the last whitespace.
      cut = remaining.lastIndexOf(" ", GOOGLE_TTS_MAX_CHARS);
      if (cut <= 0) cut = GOOGLE_TTS_MAX_CHARS;
    } else {
      cut += 1; // keep the punctuation with the preceding chunk
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trim();
  }
  return chunks;
}

// Clean raw LLM output so it reads naturally aloud: strip markdown bold,
// emoji, bullets, and special symbols, and normalize Kannada punctuation
// to a plain period so a non-Kannada voice doesn't try to pronounce the
// danda marks as unknown glyphs. Digits and Latin/Cannada letters are
// intentionally preserved — TTS reads them correctly.
function sanitizeForTts(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu,
      "",
    )
    .replace(/[•▪▸►✔︎✗︎✘︎📌👤🚨⚠️]/g, "")
    .replace(/[।॥]/g, ".")
    .replace(/[–—―]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
  // True when the last TTS attempt wanted a Kannada voice but none was
  // installed on this device/browser at all, so playback silently fell
  // back to a non-Kannada voice. Surfaced in the UI so this reads as an
  // honest platform limitation instead of a silent bug.
  const [noKannadaVoice, setNoKannadaVoice] = useState(false);

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
  const googleTtsAudioRef = useRef<HTMLAudioElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
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
    (lang: SpokenLang, voiceList: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined => {
      const wantedPrefix = lang === "kn" ? "kn" : "en";
      const localeTagDash = lang === "kn" ? "kn-in" : "en-in";
      const localeTagUnderscore = lang === "kn" ? "kn_in" : "en_in";
      const namePatterns = PREFERRED_VOICE_NAME_PATTERNS[lang];

      return (
        // 1. A known natural-sounding voice by name (Neerja, Prabhat,
        //    Sapna, Google English India, etc.) for this language.
        voiceList.find(
          (v) => v.lang.toLowerCase().startsWith(wantedPrefix) && namePatterns.some((p) => p.test(v.name)),
        ) ||
        // 2. Exact Indian locale match, e.g. "en-IN" / "kn-IN"
        voiceList.find((v) => v.lang.toLowerCase() === localeTagDash) ||
        // 3. Underscore locale variant some engines report, e.g. "en_IN"
        voiceList.find((v) => v.lang.toLowerCase() === localeTagUnderscore) ||
        // 4. Any voice for the language whose lang/name flags it as Indian
        voiceList.find(
          (v) =>
            v.lang.toLowerCase().startsWith(wantedPrefix) &&
            (v.lang.toLowerCase().includes("in") || /india/i.test(v.name)),
        )
      );
    },
    [],
  );

  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    utteranceRef.current = null;
    if (googleTtsAudioRef.current) {
      googleTtsAudioRef.current.pause();
      googleTtsAudioRef.current.src = "";
      googleTtsAudioRef.current = null;
    }
  }, []);

  // Primary streaming TTS path: pulls natural-sounding audio directly from
  // Google Translate's public TTS endpoint via an HTMLAudioElement. This
  // gives us authentic native Indian English (tl=en-IN) and authentic
  // Kannada (tl=kn) audio regardless of what the user's OS/browser has
  // installed locally — the standard speechSynthesis pipeline falls
  // back to a robotic generic voice on most desktop browsers when no
  // local voice matches. The endpoint caps a single query at ~200 chars,
  // so longer replies are split via chunkTextForGoogleTts. Returns false
  // (not throws) on any failure so the caller can fall through to the
  // local engine.
  const playViaGoogleTranslateTts = useCallback(async (text: string, langCode: string): Promise<boolean> => {
    if (typeof window === "undefined") return false;
    const chunks = chunkTextForGoogleTts(text);
    try {
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
          chunk,
        )}&tl=${langCode}&client=tw-ob`;
        await new Promise<void>((resolve, reject) => {
          const audio = new Audio(url);
          googleTtsAudioRef.current = audio;
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error("Google Translate TTS playback failed"));
          audio.play().catch(reject);
        });
      }
      return true;
    } catch {
      return false;
    } finally {
      googleTtsAudioRef.current = null;
    }
  }, []);

  const speak = useCallback(
    async (text: string, lang: SpokenLang) => {
      if (isMuted) return;
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      stopSpeaking();

      const clean = sanitizeForTts(text);
      if (!clean) return;

      // A response is "Kannada" when the caller asked in Kannada OR the
      // actual text contains Kannada script — either way we want authentic
      // Kannada audio, not an English voice trying to pronounce raw Unicode.
      const isKannada = lang === "kn" || KANNADA_SCRIPT_RE.test(clean);

      // --- Kannada path ---------------------------------------------------
      if (isKannada) {
        setNoKannadaVoice(false);
        // 1. Prefer a native local Kannada voice if the OS/browser has one
        // (rare outside Chrome OS / Android, but we check first).
        let freshVoices = window.speechSynthesis.getVoices();
        if (!freshVoices.length) freshVoices = voices;
        const knVoice = pickIndianVoice("kn", freshVoices);

        if (knVoice) {
          const utterance = new SpeechSynthesisUtterance(clean);
          utterance.lang = "kn-IN";
          utterance.rate = NATURAL_SPEECH_RATE;
          utterance.pitch = 1.0;
          utterance.voice = knVoice;
          utteranceRef.current = utterance;
          window.speechSynthesis.speak(utterance);
          return;
        }

        // 2. No native Kannada voice is installed — stream authentic Kannada
        //    audio directly from Google Translate's TTS endpoint. This is the
        //    primary path and works on any browser with network access, with
        //    no "No Kannada voice is installed" warning for the user.
        const streamed = await playViaGoogleTranslateTts(clean, "kn");
        if (streamed) return;

        // 3. Streaming also failed (offline / endpoint blocked). Surface an
        //    honest notice rather than silently playing a robotic English
        //    voice that can't pronounce Kannada script.
        setNoKannadaVoice(true);
        return;
      }

      // --- English path ---------------------------------------------------
      let freshVoices = window.speechSynthesis.getVoices();
      if (!freshVoices.length) freshVoices = voices;
      const indianVoice = pickIndianVoice("en", freshVoices);

      // 1. A native Indian English voice (Neerja, Prabhat, en-IN, etc.).
      if (indianVoice) {
        setNoKannadaVoice(false);
        const utterance = new SpeechSynthesisUtterance(clean);
        utterance.lang = "en-IN";
        utterance.rate = NATURAL_SPEECH_RATE;
        utterance.pitch = 1.0;
        utterance.voice = indianVoice;
        utteranceRef.current = utterance;
        window.speechSynthesis.speak(utterance);
        return;
      }

      // 2. No native Indian English voice — stream authentic English audio
      //    from Google Translate instead of falling back to a generic US/UK
      //    voice that would lose the local accent. Try the Indian locale tag
      //    first; some deployments don't recognise "en-IN", so fall back to
      //    plain "en".
      let streamedEn = await playViaGoogleTranslateTts(clean, "en-IN");
      if (!streamedEn) streamedEn = await playViaGoogleTranslateTts(clean, "en");
      if (streamedEn) {
        setNoKannadaVoice(false);
        return;
      }

      // 3. Streaming failed too — last resort: let the browser's default
      //    voice attempt it with the Indian locale tag set.
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = "en-IN";
      utterance.rate = NATURAL_SPEECH_RATE;
      utterance.pitch = 1.0;
      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    },
    [isMuted, pickIndianVoice, stopSpeaking, voices, playViaGoogleTranslateTts],
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

  // Belt-and-braces fix for the text input going unreadable (black-on-dark)
  // in the host page's light mode. The CSS class below already sets
  // `color: ... !important`, but if the host app's own global stylesheet
  // also has an `!important` rule targeting bare `input` elements (common
  // in some light/dark theme resets), a same-priority `!important` fight
  // is resolved by selector specificity, and a page-wide reset can still
  // win. Setting the style directly on the element via `setProperty(...,
  // "important")` writes an INLINE !important declaration, which the CSS
  // cascade always ranks above any external stylesheet rule regardless of
  // its specificity — so this wins even against page-level overrides we
  // can't see or control here. Runs whenever the text box mounts (it's
  // conditionally rendered) so it's re-applied every time it appears.
  useEffect(() => {
    if (!isTextMode) return;
    const el = textInputRef.current;
    if (!el) return;
    el.style.setProperty("background-color", "#14171f", "important");
    el.style.setProperty("color", "#f2f4f8", "important");
    el.style.setProperty("caret-color", "#f2f4f8", "important");
    el.style.setProperty("-webkit-text-fill-color", "#f2f4f8", "important");
  }, [isTextMode]);

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
        .kspp-fc-voicenotice {
          color: #e0b74f;
          font-size: 12px;
          line-height: 1.4;
          background: rgba(224, 183, 79, 0.1);
          border: 1px solid rgba(224, 183, 79, 0.25);
          border-radius: 8px;
          padding: 6px 8px;
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
          /* Pin this widget to a dark native-control theme regardless of the
             host page's light/dark mode. Without this, some browsers apply
             their own light-mode UA styling (caret, field background) to
             the input based on the page's color-scheme, which fought with
             our dark background and made typed text unreadable in light
             mode. */
          color-scheme: dark;
        }
        .kspp-fc-textform input {
          flex: 1;
          /* Explicit dark background instead of transparent: on a
             "transparent" input, some browsers still paint their own
             light-mode field background underneath in light mode, which
             combined with our light text color made typing invisible.
             An explicit background always matches the surrounding card. */
          background: #14171f;
          border: none;
          outline: none;
          color: #f2f4f8 !important;
          caret-color: #f2f4f8;
          font-size: 13.5px;
          padding: 6px 8px;
          border-radius: 8px;
        }
        .kspp-fc-textform input::placeholder { color: #6b7280; }
        /* Chrome/Edge autofill repaints the field with its own light
           background + black text, ignoring the color set above, which is
           the other common cause of "can't see what I'm typing" in light
           mode. Force it back to our dark theme. */
        .kspp-fc-textform input:-webkit-autofill,
        .kspp-fc-textform input:-webkit-autofill:hover,
        .kspp-fc-textform input:-webkit-autofill:focus {
          -webkit-text-fill-color: #f2f4f8;
          -webkit-box-shadow: 0 0 0px 1000px #14171f inset;
          box-shadow: 0 0 0px 1000px #14171f inset;
          transition: background-color 9999s ease-in-out 0s;
        }
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

          {noKannadaVoice && wasVoiceQuery && spokenLang === "kn" && !isThinking && !isMuted && (
            <div className="kspp-fc-voicenotice">
              {tr(
                "No Kannada voice is installed on this device, so audio is read in a fallback voice. The text answer above is correctly in Kannada.",
                "ಈ ಸಾಧನದಲ್ಲಿ ಕನ್ನಡ ಧ್ವನಿ ಸ್ಥಾಪಿಸಲಾಗಿಲ್ಲ, ಆದ್ದರಿಂದ ಆಡಿಯೋ ಪರ್ಯಾಯ ಧ್ವನಿಯಲ್ಲಿ ಓದಲಾಗುತ್ತದೆ. ಮೇಲಿನ ಪಠ್ಯ ಉತ್ತರ ಸರಿಯಾಗಿ ಕನ್ನಡದಲ್ಲಿದೆ.",
              )}
            </div>
          )}

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
            ref={textInputRef}
            autoFocus
            type="text"
            value={textInput}
            onChange={(e) => {
              setTextInput(e.target.value);
              // Re-assert on every keystroke too: autofill/theme repaints
              // in some browsers only kick in after the field has content,
              // not on initial mount, so mount-time enforcement alone can
              // miss it.
              const el = e.currentTarget;
              el.style.setProperty("background-color", "#14171f", "important");
              el.style.setProperty("color", "#f2f4f8", "important");
              el.style.setProperty("-webkit-text-fill-color", "#f2f4f8", "important");
            }}
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