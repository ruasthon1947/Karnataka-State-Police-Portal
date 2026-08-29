import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  GripVertical,
  Keyboard,
  Mic,
  MicOff,
  ShieldCheck,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useLanguage } from "../../context/LanguageContext";
import { askCopilot } from "../../lib/chatApi";
import { KSPP_AVATAR_SRC } from "../../assets/kspp-avatar";
import { listenViaServer, startStreamingSTT } from "../../lib/speechApi";

// The dedicated full-page AI Assistant lives at the root route.
// Hide the floating copilot there so the user never sees two copilots.
const EXCLUDED_EXACT_PATHS = ["/"];

// Vexyl TTS server config \u2014 point to wherever the vexyl-tts server is running.
// Defaults to the local dev server started by setup.sh / run.sh. REST is the
// primary path because it works through corporate proxies that block
// WebSockets; the WebSocket stays as a low-latency fast path.
const VEXYL_TTS_HOST =
  (typeof window !== "undefined"
    ? (window as any).__VEXYL_TTS_HOST__
    : undefined) || "127.0.0.1";
const VEXYL_TTS_PORT =
  (typeof window !== "undefined"
    ? (window as any).__VEXYL_TTS_PORT__
    : undefined) || 8092;
const VEXYL_HTTP_BASE = `http://${VEXYL_TTS_HOST}:${VEXYL_TTS_PORT}`;
const VEXYL_WS_URL = `ws://${VEXYL_TTS_HOST}:${VEXYL_TTS_PORT}`;
// Generous timeouts \u2014 the first synthesis after a server boot can take 30s+
// while the ai4bharat model loads into memory.
const VEXYL_REST_TIMEOUT_MS = 60_000;
const VEXYL_WS_OPEN_TIMEOUT_MS = 8_000;
// Poll interval for batch result endpoint. The model runs inference, then
// returns; we give it room before re-polling.
const VEXYL_POLL_INTERVAL_MS = 700;
const VEXYL_POLL_TIMEOUT_MS = 55_000;

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

// AudioContext is created lazily — browsers refuse to construct it before the
// first user gesture, so we wait until `speak` is actually called.
let audioContext: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (typeof window === "undefined") {
    throw new Error("AudioContext is not available in this environment");
  }
  if (!audioContext) {
    const AC =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) throw new Error("Web Audio API is not supported in this browser");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audioContext = new (AC as new () => AudioContext)();
  }
  return audioContext;
}

let vexylAudioSource: AudioBufferSourceNode | null = null;
// Module-level flag so the module-level playVexylAudio can flip it without needing
// a React ref (which can only live inside a component).
let vexylPlayingFlag = false;
// The component sets this so the audio playback can re-render the UI when
// playback starts/ends. Calling a setter from a module-level helper avoids
// stale-closure problems that come with hooks.
let vexylStateSetter: (v: boolean) => void = () => {};

async function playVexylAudio(audioBuffer: ArrayBuffer): Promise<void> {
  const ctx = getAudioContext();
  if (vexylAudioSource) {
    try {
      vexylAudioSource.stop();
    } catch {
      // ignore
    }
    vexylAudioSource = null;
  }
  vexylPlayingFlag = true;
  vexylStateSetter(true);
  // The server emits WAV (RIFF). decodeAudioData handles that natively.
  const decoded = await ctx.decodeAudioData(audioBuffer.slice(0));
  await new Promise<void>((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(ctx.destination);
    src.onended = () => {
      if (vexylAudioSource === src) vexylAudioSource = null;
      vexylPlayingFlag = false;
      vexylStateSetter(false);
      resolve();
    };
    vexylAudioSource = src;
    src.start(0);
  });
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

const GOOGLE_TTS_MAX_CHARS = 160;
const NATURAL_SPEECH_RATE = 0.95;

// ── Vexyl TTS: REST (primary) → WebSocket (fallback) ──────────────────────

/** Base64 → Uint8Array → ArrayBuffer */
function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Primary path: POST /batch/synthesize then poll /batch/result/{job_id}.
 * This works through proxies that block WebSockets and tolerates slow
 * first-boot inference (up to VEXYL_POLL_TIMEOUT_MS total).
 */
async function vexylViaRest(
  text: string,
  lang: SpokenLang,
): Promise<ArrayBuffer> {
  const langCode = lang === "kn" ? "kn-IN" : "en-IN";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VEXYL_REST_TIMEOUT_MS);

  // Submit
  let submitRes: Response;
  try {
    submitRes = await fetch(`${VEXYL_HTTP_BASE}/batch/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        lang: langCode,
        style: "warm",
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!submitRes.ok) {
    const body = await submitRes.text().catch(() => "");
    throw new Error(
      `Vexyl REST submit failed ${submitRes.status}: ${body}`,
    );
  }

  const { job_id } = await submitRes.json() as { job_id: string };
  if (!job_id) throw new Error("Vexyl REST returned no job_id");

  // Poll for result
  const pollController = new AbortController();
  const pollTimeout = setTimeout(
    () => pollController.abort(),
    VEXYL_POLL_TIMEOUT_MS,
  );

  try {
    while (true) {
      const resultRes = await fetch(
        `${VEXYL_HTTP_BASE}/batch/result/${job_id}`,
        { signal: pollController.signal },
      );

      if (resultRes.ok) {
        const result = await resultRes.json() as {
          audio_b64?: string;
          error?: string;
        };
        if (result.audio_b64) {
          return b64ToArrayBuffer(result.audio_b64);
        }
        if (result.error) {
          throw new Error(`Vexyl inference error: ${result.error}`);
        }
      }

      // Still processing — wait before next poll
      await new Promise((r) => setTimeout(r, VEXYL_POLL_INTERVAL_MS));
    }
  } finally {
    clearTimeout(pollTimeout);
  }
}

// ── WebSocket path (used as fallback if REST fails) ────────────────────────

let vexylSocket: WebSocket | null = null;
let vexylOpenPromise: Promise<WebSocket> | null = null;
let vexylRequestSeq = 0;
const vexylInflight = new Map<
  string,
  { resolve: (audio: ArrayBuffer) => void; reject: (err: Error) => void }
>();

function ensureVexylSocket(): Promise<WebSocket> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Vexyl TTS needs a browser environment"));
  }
  if (vexylSocket && vexylSocket.readyState === WebSocket.OPEN) {
    return Promise.resolve(vexylSocket);
  }
  if (vexylOpenPromise) return vexylOpenPromise;

  vexylOpenPromise = new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(VEXYL_WS_URL);
    vexylSocket = ws;

    const openTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      vexylOpenPromise = null;
      vexylSocket = null;
      reject(new Error(`Vexyl WS timeout at ${VEXYL_WS_URL}`));
    }, VEXYL_WS_OPEN_TIMEOUT_MS);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      vexylOpenPromise = null;
      resolve(ws);
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      vexylOpenPromise = null;
      vexylSocket = null;
      reject(new Error(`Vexyl WS error at ${VEXYL_WS_URL}`));
    };
    ws.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(openTimer);
        vexylOpenPromise = null;
        reject(new Error(`Vexyl WS closed before opening`));
      }
      vexylSocket = null;
      for (const [, p] of vexylInflight) p.reject(new Error("Vexyl WS closed"));
      vexylInflight.clear();
    };
    ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg?.type === "audio" && msg.request_id) {
        const p = vexylInflight.get(msg.request_id);
        if (!p) return;
        const b64 = msg.audio_b64 || msg.audio || "";
        p.resolve(b64 ? b64ToArrayBuffer(b64) : new ArrayBuffer(0));
        vexylInflight.delete(msg.request_id);
      } else if (msg?.type === "error" && msg.request_id) {
        const p = vexylInflight.get(msg.request_id);
        if (p) {
          p.reject(new Error(msg.error || "Vexyl WS error"));
          vexylInflight.delete(msg.request_id);
        }
      }
    };
  });

  return vexylOpenPromise;
}

async function vexylViaWs(
  text: string,
  lang: SpokenLang,
): Promise<ArrayBuffer> {
  const ws = await ensureVexylSocket();
  const reqId = `c-${Date.now()}-${++vexylRequestSeq}`;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    vexylInflight.set(reqId, { resolve, reject });
    try {
      ws.send(
        JSON.stringify({
          type: "synthesize",
          text,
          lang: lang === "kn" ? "kn-IN" : "en-IN",
          style: "warm",
          request_id: reqId,
        }),
      );
    } catch (err) {
      vexylInflight.delete(reqId);
      reject(err instanceof Error ? err : new Error("Vexyl WS send failed"));
    }
  });
}

/**
 * Unified entry point: try REST first, then WS, then give up and throw so the
 * caller falls through to the browser/Google TTS ladder.
 */
async function synthesizeWithVexyl(
  text: string,
  lang: SpokenLang,
): Promise<ArrayBuffer> {
  const clean = text.trim();
  if (!clean) throw new Error("Empty text for Vexyl TTS");

  // REST is primary because it handles proxies and slow cold-start inference.
  try {
    return await vexylViaRest(clean, lang);
  } catch {
    // REST failed — try WebSocket as a faster low-latency fallback.
    try {
      return await vexylViaWs(clean, lang);
    } catch (wsErr) {
      throw new Error(
        `Vexyl TTS unreachable (REST+WS): ${wsErr instanceof Error ? wsErr.message : String(wsErr)}`,
      );
    }
  }
}

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

    for (const boundary of boundaries) {
      const index = remaining.lastIndexOf(boundary, GOOGLE_TTS_MAX_CHARS);
      if (index > cut) cut = index;
    }

    if (cut <= 0) {
      cut = remaining.lastIndexOf(" ", GOOGLE_TTS_MAX_CHARS);
      if (cut <= 0) cut = GOOGLE_TTS_MAX_CHARS;
    } else {
      cut += 1;
    }

    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trim();
  }

  return chunks;
}

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

const WAVE_BARS = [
  10, 18, 30, 14, 38, 22, 48, 28, 56, 34, 64, 42, 24, 52, 70, 38, 62, 26,
  46, 18, 34, 12,
];

// Kannada → Latin (phonetic)
const KN_TO_LATIN: Record<string, string> = {
  'ಅ': 'a', 'ಆ': 'aa', 'ಇ': 'i', 'ಈ': 'ee', 'ಉ': 'u', 'ಊ': 'oo',
  'ಋ': 'r', 'ಎ': 'e', 'ಏ': 'ee', 'ಐ': 'ai', 'ಒ': 'o', 'ಓ': 'oo', 'ಔ': 'au',
  'ಕ': 'ka', 'ಖ': 'kha', 'ಗ': 'ga', 'ಘ': 'gha', 'ಙ': 'nga',
  'ಚ': 'cha', 'ಛ': 'chha', 'ಜ': 'ja', 'ಝ': 'jha', 'ಞ': 'nya',
  'ಟ': 'tta', 'ಠ': 'ttha', 'ಡ': 'dda', 'ಢ': 'ddha', 'ಣ': 'nna',
  'ತ': 'ta', 'ಥ': 'tha', 'ದ': 'da', 'ಧ': 'dha', 'ನ': 'na',
  'ಪ': 'pa', 'ಫ': 'pha', 'ಬ': 'ba', 'ಭ': 'bha', 'ಮ': 'ma',
  'ಯ': 'ya', 'ರ': 'ra', 'ಲ': 'la', 'ವ': 'va', 'ಶ': 'sha',
  'ಷ': 'ssha', 'ಸ': 'sa', 'ಹ': 'ha', 'ಳ': 'lla',
  'ಕ್ಷ': 'ksha', 'ಜ್ಞಾನ': 'jnana',
  'ು': 'u', 'ೂ': 'oo', 'ೃ': 'r', 'ೆ': 'e', 'ೇ': 'ee',
  'ೈ': 'ai', 'ೊ': 'o', 'ೋ': 'oo', 'ೌ': 'au', '್': '',
  'ಂ': 'am', 'ಃ': 'ah', '಼': '',
  'ಾ': 'aa', 'ಿ': 'i', 'ೀ': 'ee',
  '೦': '0', '೧': '1', '೨': '2', '೩': '3', '೪': '4',
  '೫': '5', '೬': '6', '೭': '7', '೮': '8', '೯': '9',
};

function transliterateKnToEn(text: string): string {
  return text.split('').map(ch => KN_TO_LATIN[ch] ?? ch).join('');
}

// English/Latin → Kannada (phonetic, best-effort)
const LATIN_TO_KN_BASE: Record<string, string> = {
  a: 'ಅ', aa: 'ಆ', i: 'ಇ', ee: 'ಈ', u: 'ಉ', oo: 'ಊ',
  e: 'ಎ', ai: 'ಐ', o: 'ಒ', au: 'ಔ',
  ka: 'ಕ', kha: 'ಖ', ga: 'ಗ', gha: 'ಘ', cha: 'ಚ',
  ja: 'ಜ', ta: 'ತ', da: 'ದ', tha: 'ಥ', pa: 'ಪ',
  ba: 'ಬ', ma: 'ಮ', ya: 'ಯ', ra: 'ರ', la: 'ಲ',
  va: 'ವ', sa: 'ಸ', ha: 'ಹ', sha: 'ಶ', na: 'ನ',
  ng: 'ಂ',
};

function transliterateEnToKn(text: string): string {
  let result = text;
  const pairs = Object.entries(LATIN_TO_KN_BASE).sort((a, b) => b[0].length - a[0].length);
  for (const [eng, kn] of pairs) {
    result = result.replace(new RegExp(eng, 'gi'), kn);
  }
  return result;
}

function getTranscriptLabel(text: string, _lang: SpokenLang): { primary: string; secondary: string; primaryLang: 'kn' | 'en'; secondaryLang: 'kn' | 'en' } {
  // Always show the original text as primary — no garbled transliteration.
  const isKannada = KANNADA_SCRIPT_RE.test(text);
  if (isKannada) {
    return {
      primary: text,
      secondary: transliterateKnToEn(text),
      primaryLang: 'kn',
      secondaryLang: 'en',
    };
  }
  // For English text, show it as-is (no Kannada transliteration)
  return {
    primary: text,
    secondary: text,
    primaryLang: 'en',
    secondaryLang: 'en',
  };
}

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
  const [noKannadaVoice, setNoKannadaVoice] = useState(false);
  const [spokenLang, setSpokenLang] = useState<SpokenLang>(
    language === "kn" ? "kn" : "en",
  );

  // Preserve the existing draggable floating-widget behavior.
  const [position, setPosition] = useState({ right: 24, bottom: 24 });
  const dragState = useRef<{
    startX: number;
    startY: number;
    startRight: number;
    startBottom: number;
    dragging: boolean;
  } | null>(null);
  const didDragRef = useRef(false);

  const onDragPointerDown = useCallback(
    (e: React.PointerEvent) => {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      didDragRef.current = false;
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

  const onDragPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return;

    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;

    if (
      !dragState.current.dragging &&
      (Math.abs(dx) > 3 || Math.abs(dy) > 3)
    ) {
      dragState.current.dragging = true;
      didDragRef.current = true;
    }

    if (!dragState.current.dragging) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const nextRight = Math.min(
      Math.max(dragState.current.startRight - dx, 8),
      Math.max(vw - 72, 8),
    );
    const nextBottom = Math.min(
      Math.max(dragState.current.startBottom - dy, 8),
      Math.max(vh - 72, 8),
    );

    setPosition({ right: nextRight, bottom: nextBottom });
  }, []);

  const onDragPointerUp = useCallback((e: React.PointerEvent) => {
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    dragState.current = null;
  }, []);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const googleTtsAudioRef = useRef<HTMLAudioElement | null>(null);
  // State mirror of `vexylPlayingFlag` so the UI re-renders when audio starts/stops.
  const [vexylPlayingState, setVexylPlayingState] = useState(false);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  // Flag to prevent onend from resetting state while server STT fallback is active.
  const serverSttActiveRef = useRef(false);
  // Streaming STT stop function — called when user clicks mic to stop.
  const streamingSttStopRef = useRef<((discard?: boolean) => void) | null>(null);

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [bilingualMode, setBilingualMode] = useState<"kn" | "en">("en");

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    const loadVoices = () => {
      setVoices(window.speechSynthesis.getVoices());
    };

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;

    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  const pickIndianVoice = useCallback(
    (
      lang: SpokenLang,
      voiceList: SpeechSynthesisVoice[],
    ): SpeechSynthesisVoice | undefined => {
      const wantedPrefix = lang === "kn" ? "kn" : "en";
      const localeTagDash = lang === "kn" ? "kn-in" : "en-in";
      const localeTagUnderscore = lang === "kn" ? "kn_in" : "en_in";

      const preferredNames =
        lang === "kn"
          ? [/sapna/i, /kannada/i, /google.*ಕನ್ನಡ/i, /ಕನ್ನಡ/]
          : [
              /neerja/i,
              /prabhat/i,
              /google.*english.*india/i,
              /english.*india/i,
              /india.*english/i,
            ];

      return (
        voiceList.find(
          (voice) =>
            voice.lang.toLowerCase().startsWith(wantedPrefix) &&
            preferredNames.some((pattern) => pattern.test(voice.name)),
        ) ||
        voiceList.find(
          (voice) => voice.lang.toLowerCase() === localeTagDash,
        ) ||
        voiceList.find(
          (voice) => voice.lang.toLowerCase() === localeTagUnderscore,
        ) ||
        voiceList.find(
          (voice) =>
            voice.lang.toLowerCase().startsWith(wantedPrefix) &&
            (voice.lang.toLowerCase().includes("in") ||
              /india/i.test(voice.name)),
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

    if (vexylAudioSource) {
      try {
        vexylAudioSource.stop();
      } catch {
        // ignore — already stopped
      }
      vexylAudioSource = null;
    }
    vexylPlayingFlag = false;
    vexylStateSetter(false);
  }, []);

  const playViaGoogleTranslateTts = useCallback(
    async (text: string, langCode: string): Promise<boolean> => {
      if (typeof window === "undefined") return false;

      const chunks = chunkTextForGoogleTts(text);

      try {
        for (const chunk of chunks) {
          if (!chunk.trim()) continue;

          const url =
            `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
              chunk,
            )}&tl=${langCode}&client=tw-ob`;

          await new Promise<void>((resolve, reject) => {
            const audio = new Audio(url);
            googleTtsAudioRef.current = audio;

            audio.onended = () => resolve();
            audio.onerror = () =>
              reject(new Error("Google Translate TTS playback failed"));

            audio.play().catch(reject);
          });
        }

        return true;
      } catch {
        return false;
      } finally {
        googleTtsAudioRef.current = null;
      }
    },
    [],
  );

  const speak = useCallback(
    async (text: string, lang: SpokenLang) => {
      if (isMuted) return;
      if (typeof window === "undefined" || !window.speechSynthesis) return;

      stopSpeaking();

      const clean = sanitizeForTts(text);
      if (!clean) return;

      const isKannada = lang === "kn" || KANNADA_SCRIPT_RE.test(clean);

      // Prefer the vexyl-tts server (ai4bharat/indic-parler-tts) for natural
      // Indian-accent voices. If it's reachable the answer is read in proper
      // Kannada / Indian English. Falls back to browser/Google TTS only if the
      // server is not running.
      try {
        const audioBuffer = await synthesizeWithVexyl(clean, isKannada ? "kn" : "en");
        await playVexylAudio(audioBuffer);
        // Vexyl played successfully — clear any prior "no Kannada voice" flag.
        setNoKannadaVoice(false);
        return;
      } catch (vexylErr) {
        // Vexyl server unavailable — log and fall through to the existing TTS ladder.
        console.warn("Vexyl TTS unavailable, using fallback:", vexylErr);
      }

      if (isKannada) {
        setNoKannadaVoice(false);

        let freshVoices = window.speechSynthesis.getVoices();
        if (!freshVoices.length) freshVoices = voices;

        const knVoice = pickIndianVoice("kn", freshVoices);

        if (knVoice) {
          const utterance = new SpeechSynthesisUtterance(clean);
          utterance.lang = "kn-IN";
          utterance.rate = NATURAL_SPEECH_RATE;
          utterance.pitch = 1;
          utterance.voice = knVoice;
          utteranceRef.current = utterance;
          window.speechSynthesis.speak(utterance);
          return;
        }

        const streamed = await playViaGoogleTranslateTts(clean, "kn");
        if (streamed) return;

        setNoKannadaVoice(true);
        return;
      }

      let freshVoices = window.speechSynthesis.getVoices();
      if (!freshVoices.length) freshVoices = voices;

      const indianVoice = pickIndianVoice("en", freshVoices);

      if (indianVoice) {
        setNoKannadaVoice(false);

        const utterance = new SpeechSynthesisUtterance(clean);
        utterance.lang = "en-IN";
        utterance.rate = NATURAL_SPEECH_RATE;
        utterance.pitch = 1;
        utterance.voice = indianVoice;
        utteranceRef.current = utterance;
        window.speechSynthesis.speak(utterance);
        return;
      }

      let streamedEn = await playViaGoogleTranslateTts(clean, "en-IN");
      if (!streamedEn) {
        streamedEn = await playViaGoogleTranslateTts(clean, "en");
      }

      if (streamedEn) {
        setNoKannadaVoice(false);
        return;
      }

      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = "en-IN";
      utterance.rate = NATURAL_SPEECH_RATE;
      utterance.pitch = 1;
      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    },
    [
      isMuted,
      pickIndianVoice,
      playViaGoogleTranslateTts,
      stopSpeaking,
      voices,
    ],
  );

  const submitQuestion = useCallback(
    async (
      question: string,
      viaVoice: boolean,
      voiceLangHint?: SpokenLang,
    ) => {
      const trimmed = question.trim();
      if (!trimmed) return;

      // When KN mode is selected, always reply in Kannada — even if the
      // question was typed in English.  Only auto-detect from script when
      // the user is in EN mode but typed Kannada characters.
      const answerLang: SpokenLang = spokenLang === "kn"
        ? "kn"
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
        const reply = await askCopilot({
          question: trimmed,
          language: answerLang,
        });

        setAnswer(reply);
        setState("responding");

        if (viaVoice) {
          void speak(reply, answerLang);
        }
      } catch (err) {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : tr(
                "Something went wrong. Please try again.",
                "ಏನೋ ತಪ್ಪಾಗಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
              ),
        );
        setState("idle");
      }
    },
    [speak, spokenLang, stopSpeaking, tr],
  );

  // Server-side STT fallback — streaming with real-time captions.
  // Used when the browser Web Speech API is unavailable (Brave, Electron, etc.).
  const serverListenFallback = useCallback(() => {
    stopSpeaking();
    setErrorMsg(null);
    setAnswer(null);
    setAskedQuestion(null);
    setInterimTranscript("");
    setIsOpen(true);
    // Stop any browser STT that might be running from a previous mode.
    recognitionRef.current?.stop();
    recognitionRef.current = null;

    setState("listening");
    serverSttActiveRef.current = true;

    const lang: "en" | "kn" = spokenLang === "kn" ? "kn" : "en";
    setBilingualMode(lang);
    let finalTranscript = "";
    let stopped = false;

    const finishServerStt = () => {
      serverSttActiveRef.current = false;
      streamingSttStopRef.current = null;
    };

    const { stop } = startStreamingSTT(
      lang,
      // onTranscript — called every ~3 seconds with live captions.
      // Keep interimTranscript updated so the user sees captions.
      // Only set askedQuestion on final submission.
      (text, isFinal) => {
        if (stopped) return;
        setInterimTranscript(text);
        finalTranscript = text;

        // When the final chunk arrives, submit the question
        if (isFinal && text.trim()) {
          stopped = true;
          finishServerStt();
          setInterimTranscript("");
          void submitQuestion(text, true, lang);
        } else if (isFinal) {
          // Final chunk but no speech detected
          stopped = true;
          finishServerStt();
          setInterimTranscript("");
          setErrorMsg(
            tr(
              "No speech detected. Please try again.",
              "ಧ್ವನಿ ಪತ್ತೆಯಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
            ),
          );
          setState("idle");
        }
      },
      // onError
      (errorMsg) => {
        if (stopped) return;
        setErrorMsg(
          errorMsg.includes("Microphone")
            ? tr(
                "Microphone is not available. Please allow microphone access and try again.",
                "ಮೈಕ್ರೊಫೋನ್ ಲಭ್ಯವಿಲ್ಲ. ದಯವಿಟ್ಟು ಮೈಕ್ರೊಫೋನ್ ಪ್ರವೇಶವನ್ನು ಅನುಮತಿಸಿ.",
              )
            : tr(
                "Live captions are temporarily unavailable; recording is still active.",
                "ಲೈವ್ ಶೀರ್ಷಿಕೆಗಳು ತಾತ್ಕಾಲಿಕವಾಗಿ ಲಭ್ಯವಿಲ್ಲ; ರೆಕಾರ್ಡಿಂಗ್ ಇನ್ನೂ ಸಕ್ರಿಯವಾಗಿದೆ.",
              ),
        );
        if (errorMsg.includes("Microphone") || errorMsg.includes("supported")) {
          stopped = true;
          finishServerStt();
          setState("idle");
        }
      },
    );

    streamingSttStopRef.current = stop;
  }, [spokenLang, stopSpeaking, submitQuestion, tr]);

  const toggleListening = useCallback(() => {
    if (state === "listening") {
      // Stop browser Web Speech API if active
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      // Stop server streaming STT if active
      if (streamingSttStopRef.current) {
        streamingSttStopRef.current();
        streamingSttStopRef.current = null;
      }
      serverSttActiveRef.current = false;
      setState("idle");
      setInterimTranscript("");
      return;
    }

    // If server STT is already running (from KN mode), don't start browser STT.
    if (serverSttActiveRef.current) return;

    // Use the PCM streaming path for both languages. It supports long speech
    // and avoids browser Web Speech ending after a short pause.
    serverListenFallback();
    return;
  }, [spokenLang, state, stopSpeaking, submitQuestion, tr]);

  const openConsole = useCallback(() => {
    setIsOpen(true);
    setIsTextMode(false);
    setErrorMsg(null);
  }, []);

  const closeConsole = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopSpeaking();

    setIsOpen(false);
    setIsTextMode(false);
    setAnswer(null);
    setAskedQuestion(null);
    setInterimTranscript("");
    setErrorMsg(null);
    setState("idle");
  }, [stopSpeaking]);

  const toggleMute = useCallback(() => {
    setIsMuted((previous) => {
      const next = !previous;
      if (next) stopSpeaking();
      return next;
    });
  }, [stopSpeaking]);

  const handleTextSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const question = textInput.trim();
      if (!question) return;

      setTextInput("");
      void submitQuestion(question, false);
    },
    [submitQuestion, textInput],
  );

  useEffect(() => {
    if (isExcludedRoute) return;

    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen(true);
        setIsTextMode(true);
      }

      if (e.key === "Escape" && isOpen) {
        closeConsole();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeConsole, isExcludedRoute, isOpen]);

  useEffect(() => stopSpeaking, [stopSpeaking]);

  useEffect(() => {
    // Register the state setter so the module-level playVexylAudio can flip
    // the React state when playback starts/ends.
    vexylStateSetter = setVexylPlayingState;
    return () => {
      vexylStateSetter = () => {};
    };
  }, []);

  useEffect(() => {
    if (!isTextMode) return;

    const el = textInputRef.current;
    if (!el) return;

    el.style.setProperty("background-color", "#071b3a", "important");
    el.style.setProperty("color", "#ffffff", "important");
    el.style.setProperty("caret-color", "#ffffff", "important");
    el.style.setProperty("-webkit-text-fill-color", "#ffffff", "important");
  }, [isTextMode]);

  if (isExcludedRoute || !user) return null;

  const isListening = state === "listening";
  const isThinking = state === "thinking";
  const isResponding = state === "responding";
  const hasResult = Boolean(answer && !errorMsg);
  const isSpeechPlaying =
    (typeof window !== "undefined" && Boolean(window.speechSynthesis?.speaking)) ||
    vexylPlayingState;

  const statusText = isListening
    ? tr("Listening...", "ಆಲಿಸಲಾಗುತ್ತಿದೆ...")
    : isThinking
      ? tr("Checking records...", "ದಾಖಲೆಗಳನ್ನು ಪರಿಶೀಲಿಸಲಾಗುತ್ತಿದೆ...")
      : isResponding
        ? tr("Secure response", "ಸುರಕ್ಷಿತ ಉತ್ತರ")
        : tr("Voice ready", "ಧ್ವನಿ ಸಿದ್ಧ");

  const responseLanguage = KANNADA_SCRIPT_RE.test(answer || "")
    ? "kn"
    : spokenLang;

  return (
    <div
      className="fixed z-[9999] flex flex-col items-end gap-3"
      style={{
        right: `max(${position.right}px, 12px)`,
        bottom: `max(${position.bottom}px, 12px)`,
      }}
      aria-live="polite"
    >
      {/* Expanded KSPP Voice Console */}
      {isOpen && (
        <div
          className="w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-white/10 bg-[#061b3c] text-white shadow-[0_24px_70px_rgba(0,0,0,0.45)] ring-1 ring-[#2d8cff]/10 dark:text-white"
          role="dialog"
          aria-modal="false"
          aria-label={tr("KSPP Voice Console", "ಕೆಎಸ್‌ಪಿಪಿ ಧ್ವನಿ ಕನ್ಸೋಲ್")}
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerUp}
          onPointerCancel={onDragPointerUp}
        >
          {/* Distinct top accent */}
          <div className="h-1 bg-gradient-to-r from-[#0f5ed7] via-[#2d8cff] to-[#d5a83d]" />

          {/* Header */}
          <div
            className="flex cursor-grab touch-none items-center justify-between px-4 pb-2 pt-3 active:cursor-grabbing"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full border border-white/15 bg-[#092653]">
                <img
                  src={KSPP_AVATAR_SRC}
                  alt="KSPP"
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold tracking-wide" style={{ color: '#ffffff' }}>
                  {tr("KSPP Voice Console", "ಕೆಎಸ್‌ಪಿಪಿ ಧ್ವನಿ ಕನ್ಸೋಲ್")}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[10px] font-medium" style={{ color: '#6ee7b7' }}>
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
                  {tr("Secure", "ಸುರಕ್ಷಿತ")}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeConsole();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/65 transition hover:bg-white/10 hover:text-white"
              title={tr("Close", "ಮುಚ್ಚಿ")}
              aria-label={tr("Close voice console", "ಧ್ವನಿ ಕನ್ಸೋಲ್ ಮುಚ್ಚಿ")}
            >
              <X size={19} strokeWidth={1.8} />
            </button>
          </div>

          {/* Language selector */}
          <div className="px-5 pb-3 pt-1">
            <div className="mx-auto flex max-w-[205px] rounded-full border border-white/10 bg-[#07142b] p-0.5 shadow-inner">
              <button
                type="button"
                onClick={() => { setSpokenLang("en"); setBilingualMode("en"); }}
                onPointerDown={(e) => e.stopPropagation()}
                className={`flex-1 rounded-full px-4 py-1.5 text-[11px] font-semibold transition ${
                  spokenLang === "en"
                    ? "bg-[#1264e6] text-white shadow-[0_4px_12px_rgba(18,100,230,0.35)]"
                    : "text-white/50 hover:text-white/80"
                }`}
              >
                English
              </button>
              <button
                type="button"
                onClick={() => { setSpokenLang("kn"); setBilingualMode("kn"); }}
                onPointerDown={(e) => e.stopPropagation()}
                className={`flex-1 rounded-full px-4 py-1.5 text-[11px] font-semibold transition ${
                  spokenLang === "kn"
                    ? "bg-[#1264e6] text-white shadow-[0_4px_12px_rgba(18,100,230,0.35)]"
                    : "text-white/50 hover:text-white/80"
                }`}
              >
                ಕನ್ನಡ
              </button>
            </div>
          </div>

          {/* Central voice visualizer */}
          <div className="relative flex h-[172px] items-center justify-center overflow-hidden">
            <div className="absolute inset-x-3 top-1/2 flex -translate-y-1/2 items-center justify-center gap-[3px] opacity-75">
              {WAVE_BARS.map((height, index) => (
                <span
                  key={`${height}-${index}`}
                  className={`w-[3px] rounded-full bg-[#2379e8]/75 ${
                    isListening ? "animate-pulse" : ""
                  }`}
                  style={{
                    height: `${height}px`,
                    animationDelay: `${index * 55}ms`,
                  }}
                />
              ))}
            </div>

            <div className="absolute h-32 w-32 rounded-full border border-[#d6a53a]/20" />
            <div className="absolute h-28 w-28 rounded-full border border-[#d6a53a]/45 shadow-[0_0_35px_rgba(214,165,58,0.16)]" />

            <div
              className={`absolute h-24 w-24 rounded-full border border-[#d6a53a] transition-all ${
                isListening
                  ? "animate-pulse shadow-[0_0_0_7px_rgba(214,165,58,0.10),0_0_38px_rgba(214,165,58,0.38)]"
                  : "shadow-[0_0_0_5px_rgba(214,165,58,0.07),0_0_28px_rgba(214,165,58,0.20)]"
              }`}
            />

            <button
              type="button"
              onClick={toggleListening}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={isThinking}
              className={`relative z-10 grid h-[72px] w-[72px] place-items-center rounded-full border border-[#3e8df7] bg-[#0b4fae] text-white shadow-[inset_0_1px_10px_rgba(255,255,255,0.12),0_10px_28px_rgba(0,0,0,0.28)] transition hover:bg-[#1264d1] disabled:cursor-not-allowed disabled:opacity-70 ${
                isListening ? "scale-105 bg-[#0a57c1]" : ""
              }`}
              title={
                isListening
                  ? tr("Tap to stop", "ನಿಲ್ಲಿಸಲು ಟ್ಯಾಪ್ ಮಾಡಿ")
                  : tr("Tap to talk", "ಮಾತನಾಡಲು ಟ್ಯಾಪ್ ಮಾಡಿ")
              }
              aria-label={
                isListening
                  ? tr("Stop listening", "ಆಲಿಸುವುದನ್ನು ನಿಲ್ಲಿಸಿ")
                  : tr("Talk to the Copilot", "ಸಹಾಯಕದೊಂದಿಗೆ ಮಾತನಾಡಿ")
              }
            >
              {isListening ? (
                <MicOff size={30} strokeWidth={1.8} />
              ) : (
                <Mic size={31} strokeWidth={1.8} />
              )}
            </button>
          </div>

          {/* Live transcript bubble — hidden once askedQuestion is shown to avoid duplicate */}
          {isListening && interimTranscript && !askedQuestion && (
            <div className="flex items-center gap-2 bg-slate-800/80 border border-slate-700/60 rounded-full px-4 py-2 text-xs text-white my-3">
              <span className="text-blue-400">👤</span>
              <span className="truncate flex-1">
                {(() => {
                  const label = getTranscriptLabel(interimTranscript, spokenLang);
                  if (label.primaryLang === bilingualMode) return label.primary;
                  return label.secondary || label.primary;
                })()}
              </span>
              <div
                role="tablist"
                aria-label="Transcript language"
                className="flex shrink-0 items-center gap-0.5 rounded-full border border-white/10 bg-black/30 p-0.5"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={bilingualMode === "kn"}
                  onClick={() => setBilingualMode("kn")}
                  className={`px-2 py-0.5 text-[10px] font-semibold rounded-full transition ${
                    bilingualMode === "kn"
                      ? "bg-[#1264e6] text-white"
                      : "text-white/60 hover:text-white"
                  }`}
                >
                  KN
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={bilingualMode === "en"}
                  onClick={() => setBilingualMode("en")}
                  className={`px-2 py-0.5 text-[10px] font-semibold rounded-full transition ${
                    bilingualMode === "en"
                      ? "bg-[#1264e6] text-white"
                      : "text-white/60 hover:text-white"
                  }`}
                >
                  EN
                </button>
              </div>
              {/* Send icon — submit what you've said so far */}
              <button
                type="button"
                onClick={() => {
                  // Stop streaming STT
                  if (streamingSttStopRef.current) {
                    streamingSttStopRef.current();
                    streamingSttStopRef.current = null;
                  }
                  // Also stop browser speech recognition if active
                  recognitionRef.current?.stop();
                  recognitionRef.current = null;
                  setInterimTranscript("");
                }}
                className="ml-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#1264e6] text-white shadow transition hover:bg-[#1a7af7] active:scale-95"
                title={tr("Send", "ಕಳುಹಿಸಿ")}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          )}

          {/* User query bubble (bilingual with KN/EN toggle) */}
          {askedQuestion && (
            <div className="mx-3 mb-2 flex items-center gap-2 rounded-full border border-white/10 bg-[#092653] px-3 py-2 text-[11px] text-white/85 !important shadow-inner">
              <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#12386e] text-[#8fc2ff]">
                <UserRound size={13} />
              </div>
              <span className="min-w-0 flex-1 truncate">
                {(() => {
                  const label = getTranscriptLabel(askedQuestion, spokenLang);
                  if (label.primaryLang === bilingualMode) return label.primary;
                  return label.secondary || label.primary;
                })()}
              </span>
              <div
                role="tablist"
                aria-label="Query language"
                className="flex shrink-0 items-center gap-0.5 rounded-full border border-white/10 bg-black/30 p-0.5"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={bilingualMode === "kn"}
                  onClick={() => setBilingualMode("kn")}
                  className={`px-2 py-0.5 text-[10px] font-semibold rounded-full transition ${
                    bilingualMode === "kn"
                      ? "bg-[#1264e6] text-white"
                      : "text-white/60 hover:text-white"
                  }`}
                >
                  KN
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={bilingualMode === "en"}
                  onClick={() => setBilingualMode("en")}
                  className={`px-2 py-0.5 text-[10px] font-semibold rounded-full transition ${
                    bilingualMode === "en"
                      ? "bg-[#1264e6] text-white"
                      : "text-white/60 hover:text-white"
                  }`}
                >
                  EN
                </button>
              </div>
            </div>
          )}

          {/* Processing state */}
          {isThinking && (
            <div className="mx-3 mb-2 flex items-center gap-2 rounded-xl border border-white/10 bg-[#092653] px-3 py-2.5 text-[11px] text-white/65 !important">
              <span className="flex gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#56a3ff]" />
                <span
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#56a3ff]"
                  style={{ animationDelay: "120ms" }}
                />
                <span
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#56a3ff]"
                  style={{ animationDelay: "240ms" }}
                />
              </span>
              {statusText}
            </div>
          )}

          {/* Assistant response */}
          {hasResult && (
            <div className="mx-3 mb-3 flex items-center gap-3 rounded-xl bg-white px-3.5 py-3 text-slate-900 shadow-[0_8px_22px_rgba(0,0,0,0.18)]">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-600">
                <ShieldCheck size={22} strokeWidth={2.1} />
              </div>

              <div className="min-w-0 flex-1 text-[12px] font-semibold leading-5 max-h-48 overflow-y-auto">
                {answer}
              </div>

              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  if (isSpeechPlaying) {
                    stopSpeaking();
                  } else if (answer) {
                    void speak(answer, responseLanguage);
                  }
                }}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                title={tr("Play / stop audio", "ಆಡಿಯೋ ಪ್ಲೇ / ನಿಲ್ಲಿಸಿ")}
                aria-label={tr(
                  "Play or stop audio response",
                  "ಆಡಿಯೋ ಪ್ರತಿಕ್ರಿಯೆಯನ್ನು ಪ್ಲೇ ಅಥವಾ ನಿಲ್ಲಿಸಿ",
                )}
              >
                {isSpeechPlaying ? (
                  <VolumeX size={18} />
                ) : (
                  <Volume2 size={18} />
                )}
              </button>
            </div>
          )}

          {/* Errors */}
          {errorMsg && (
            <div className="mx-3 mb-3 rounded-xl border border-red-300/20 bg-red-500/10 px-3 py-2.5 text-[11px] leading-4 text-red-200">
              {errorMsg}
            </div>
          )}

          {/* Kannada voice fallback notice — shown only when ALL TTS paths (Vexyl + browser + Google) failed */}
          {noKannadaVoice &&
            !isThinking &&
            !isMuted && (
              <div className="mx-3 mb-3 rounded-xl border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-[10px] leading-4 text-amber-200">
                {tr(
                  "⚠ Vexyl TTS server not reachable at " +
                    VEXYL_HTTP_BASE +
                    ". To hear Kannada / Indian English with natural voice, start it: cd vexyl-tts && ./run.sh",
                  "⚠ Vexyl TTS ಸರ್ವರ್ " +
                    VEXYL_HTTP_BASE +
                    " ತಲುಪಲಾಗುತ್ತಿಲ್ಲ. ನೈಸರ್ಗಿಕ ಕನ್ನಡ/ಇಂಗ್ಲಿಷ್ ಧ್ವನಿಯನ್ನು ಕೇಳಲು: cd vexyl-tts && ./run.sh",
                )}
              </div>
            )}

          {/* Text input mode */}
          {isTextMode && (
            <form
              onSubmit={handleTextSubmit}
              onPointerDown={(e) => e.stopPropagation()}
              className="mx-3 mb-3 flex items-center gap-2 rounded-xl border border-white/10 bg-[#07142b] p-1.5"
            >
              <div className="relative min-w-0 flex-1">
                <input
                  ref={textInputRef}
                  autoFocus
                  type="text"
                  value={textInput}
                  onChange={(e) => {
                    setTextInput(e.target.value);
                    const el = e.currentTarget;
                    el.style.setProperty(
                      "background-color",
                      "#071b3a",
                      "important",
                    );
                    el.style.setProperty("color", "#ffffff", "important");
                    el.style.setProperty(
                      "-webkit-text-fill-color",
                      "#ffffff",
                      "important",
                    );
                  }}
                  placeholder={tr(
                    "Type a question...",
                    "ಪ್ರಶ್ನೆಯನ್ನು ಟೈಪ್ ಮಾಡಿ...",
                  )}
                  className="w-full rounded-lg border-0 bg-[#071b3a] pl-2.5 pr-8 py-2 text-xs outline-none placeholder:text-white/35 focus:ring-0"
                  style={{ color: '#ffffff', WebkitTextFillColor: '#ffffff', caretColor: '#ffffff' }}
                />
                <button
                  type="submit"
                  onPointerDown={(e) => e.stopPropagation()}
                  disabled={!textInput.trim() || isThinking}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 grid h-6 w-6 place-items-center rounded-full text-white/40 transition hover:text-[#2173f0] disabled:cursor-not-allowed disabled:opacity-30"
                  title={tr("Send", "ಕಳುಹಿಸಿ")}
                >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
              </div>
            </form>
          )}

          {/* Quick controls */}
          <div className="border-t border-white/10 px-4 pb-2 pt-3">
            <div className="flex items-start justify-between">
              <button
                type="button"
                onClick={() => setIsTextMode((value) => !value)}
                onPointerDown={(e) => e.stopPropagation()}
                className="grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-white/5 text-white/65 transition hover:bg-white/10 hover:text-white"
                title={tr(
                  "Type a question instead of speaking",
                  "ಮಾತನಾಡುವ ಬದಲು ಪ್ರಶ್ನೆಯನ್ನು ಟೈಪ್ ಮಾಡಿ",
                )}
                aria-label={tr(
                  "Toggle text input",
                  "ಪಠ್ಯ ಇನ್‌ಪುಟ್ ಟಾಗಲ್ ಮಾಡಿ",
                )}
              >
                <Keyboard size={19} />
              </button>

              <div className="flex flex-col items-center">
                {/* When listening with captions, show Retry + Send; otherwise Mic/Stop */}
                {isListening && interimTranscript ? (
                  <div className="flex items-center gap-3">
                    {/* Retry — discard current captions and re-record */}
                    <button
                      type="button"
                      onClick={() => {
                        setInterimTranscript("");
                        setAskedQuestion(null);
                        // Discard the current stream before starting a new one.
                        if (streamingSttStopRef.current) {
                          streamingSttStopRef.current(true);
                          streamingSttStopRef.current = null;
                        }
                        recognitionRef.current?.stop();
                        recognitionRef.current = null;
                        setState("idle");
                        setTimeout(() => serverListenFallback(), 150);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-white/10 text-white/70 transition hover:bg-white/20 hover:text-white"
                      title={tr("Re-record", "ಮರು-ರೆಕಾರ್ಡ್")}
                      aria-label={tr("Re-record", "ಮರು-ರೆಕಾರ್ಡ್")}
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="23 4 23 10 17 10" />
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                      </svg>
                    </button>

                    {/* Send — submit what was said */}
                    <button
                      type="button"
                      onClick={() => {
                        const text = interimTranscript.trim();
                        if (streamingSttStopRef.current) {
                          streamingSttStopRef.current();
                          streamingSttStopRef.current = null;
                        }
                        recognitionRef.current?.stop();
                        recognitionRef.current = null;
                        setInterimTranscript("");
                        if (!text) setState("idle");
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      disabled={isThinking}
                      className="grid h-14 w-14 place-items-center rounded-full border border-emerald-400 bg-emerald-600 text-white shadow-[0_7px_20px_rgba(16,185,129,0.35)] transition hover:bg-emerald-500"
                      title={tr("Send", "ಕಳುಹಿಸಿ")}
                      aria-label={tr("Send message", "ಸಂದೇಶ ಕಳುಹಿಸಿ")}
                    >
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="22" y1="2" x2="11" y2="13" />
                        <polygon points="22 2 15 22 11 13 2 9 22 2" />
                      </svg>
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={toggleListening}
                    onPointerDown={(e) => e.stopPropagation()}
                    disabled={isThinking}
                    className={`grid h-14 w-14 place-items-center rounded-full border border-[#378af1] bg-[#075bc9] text-white shadow-[0_7px_20px_rgba(0,87,201,0.32)] transition hover:bg-[#126bdf] disabled:cursor-not-allowed disabled:opacity-50 ${
                      isListening ? "animate-pulse" : ""
                    }`}
                    title={
                      isListening
                        ? tr("Stop listening", "ಆಲಿಸುವುದನ್ನು ನಿಲ್ಲಿಸಿ")
                        : tr("Ask again", "ಮತ್ತೆ ಕೇಳಿ")
                    }
                    aria-label={
                      isListening
                        ? tr("Stop listening", "ಆಲಿಸುವುದನ್ನು ನಿಲ್ಲಿಸಿ")
                        : tr("Ask again", "ಮತ್ತೆ ಕೇಳಿ")
                    }
                  >
                    {isListening ? (
                      <MicOff size={24} />
                    ) : (
                      <Mic size={24} />
                    )}
                  </button>
                )}
                <span className="mt-1.5 text-[10px] text-white/55">
                  {isListening && interimTranscript
                    ? tr("Retry / Send", "ಮರು-ರೆಕಾರ್ಡ್ / ಕಳುಹಿಸಿ")
                    : isListening
                      ? tr("Listening", "ಆಲಿಸಲಾಗುತ್ತಿದೆ")
                      : tr("Ask again", "ಮತ್ತೆ ಕೇಳಿ")}
                </span>
              </div>

              <button
                type="button"
                onClick={toggleMute}
                onPointerDown={(e) => e.stopPropagation()}
                className={`grid h-11 w-11 place-items-center rounded-full border transition ${
                  isMuted
                    ? "border-red-300/20 bg-red-400/10 text-red-200"
                    : "border-white/10 bg-white/5 text-white/65 hover:bg-white/10 hover:text-white"
                }`}
                title={tr(
                  "Mute voice responses",
                  "ಧ್ವನಿ ಪ್ರತಿಕ್ರಿಯೆಗಳನ್ನು ಮ್ಯೂಟ್ ಮಾಡಿ",
                )}
                aria-label={tr("Toggle mute", "ಮ್ಯೂಟ್ ಟಾಗಲ್ ಮಾಡಿ")}
              >
                {isMuted ? <VolumeX size={19} /> : <Volume2 size={19} />}
              </button>
            </div>

            <div className="mt-2 flex items-center justify-center gap-1.5 text-[10px] text-white/50 !important">
              <span>
                {spokenLang === "kn" ? "ಕನ್ನಡ" : "English (India)"}
              </span>
              <span className="text-emerald-400 !important">•</span>
              <span>{statusText}</span>
            </div>
          </div>
        </div>
      )}

      {/* Collapsed floating badge / trigger */}
      {!isOpen && (
        <button
          type="button"
          onClick={() => {
            if (didDragRef.current) {
              didDragRef.current = false;
              return;
            }
            openConsole();
          }}
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerUp}
          className={`group relative grid h-[72px] w-[72px] touch-none place-items-center rounded-full border border-white/20 bg-[#06234b] shadow-[0_16px_40px_rgba(0,0,0,0.35)] ring-1 ring-[#1b75dd]/30 transition hover:scale-[1.03] hover:bg-[#092c5c] ${
            isListening ? "ring-4 ring-red-400/20" : ""
          }`}
          title={tr("Open KSPP Voice Console", "ಕೆಎಸ್‌ಪಿಪಿ ಧ್ವನಿ ಕನ್ಸೋಲ್ ತೆರೆಯಿರಿ")}
          aria-label={tr(
            "Open KSPP Voice Console",
            "ಕೆಎಸ್‌ಪಿಪಿ ಧ್ವನಿ ಕನ್ಸೋಲ್ ತೆರೆಯಿರಿ",
          )}
        >
          {/* subtle gold inner ring */}
          <span className="absolute inset-[7px] rounded-full border border-[#d4a53a]/45" />

          <span className="grid h-12 w-12 place-items-center rounded-full bg-[#0a356d] text-white shadow-[inset_0_0_18px_rgba(45,140,255,0.18)]">
            <Mic size={27} strokeWidth={1.8} />
          </span>

          {/* KSPP crest/logo overlay */}
          <span className="absolute bottom-1 left-1 grid h-7 w-7 overflow-hidden rounded-full border border-white/30 bg-[#082754] shadow-lg">
            <img
              src={KSPP_AVATAR_SRC}
              alt="KSPP"
              className="h-full w-full object-cover"
            />
          </span>

          {/* EN badge */}
          <span className="absolute bottom-1 right-1 grid h-6 min-w-6 place-items-center rounded-full border border-[#0b376c] bg-white px-1 text-[8px] font-extrabold text-[#082754] shadow-md">
            {spokenLang === "kn" ? "ಕ" : "EN"}
          </span>

          {/* Secure indicator */}
          <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full border border-[#06234b] bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
        </button>
      )}

    </div>
  );
};

export default FloatingCopilot;
