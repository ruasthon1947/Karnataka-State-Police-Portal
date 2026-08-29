import "dotenv/config";
import { checkSpeechRateLimit, requireSession } from "./security.mjs";

// ---------------------------------------------------------------------------
// Configuration — Groq Whisper (whisper-large-v3-turbo)
// ---------------------------------------------------------------------------

const GROQ_KEYS = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);
const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";
const GROQ_WHISPER_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

const STT_ENABLED = GROQ_KEYS.length > 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let received = 0;
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > 3_000_000) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error("Invalid JSON body."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Groq Whisper transcription
// ---------------------------------------------------------------------------

async function transcribeAudio(audioBase64, lang, mimeType) {
  if (GROQ_KEYS.length === 0) {
    throw Object.assign(
      new Error("Speech-to-text is not configured. Set GROQ_API_KEYS."),
      { status: 503 },
    );
  }

  const audioBuffer = Buffer.from(audioBase64, "base64");

  // whisper-large-v3-turbo misidentifies Kannada as Hindi/Urdu.
  // Use the full whisper-large-v3 model with an explicit language hint
  // for Kannada.  For English keep the turbo model with hint for speed.
  const isKannada = lang === "kn";
  const model = isKannada ? "whisper-large-v3" : GROQ_WHISPER_MODEL;
  let whisperLang = isKannada ? "kn" : (lang === "en" ? "en" : lang);
  console.log(`[STT] lang=${lang} model=${model} hint=${whisperLang || "(auto-detect)"} audioBytes=${audioBuffer.length}`);

  // Detect if output is Hindi (Devanagari \u0900-\u097F) instead of Kannada (\u0C80-\u0CFF)
  const DEVANAGARI_RE = /[\u0900-\u097F]/;
  const KANNADA_RE = /[\u0C80-\u0CFF]/;
  function looksLikeWrongLanguage(text, expectedLang) {
    if (expectedLang !== "kn") return false;
    // If text has Devanagari but no Kannada — it's Hindi, not Kannada
    return DEVANAGARI_RE.test(text) && !KANNADA_RE.test(text);
  }

  async function callWhisper(apiKey, modelToUse, languageHint) {
    const blob = new Blob([audioBuffer], { type: mimeType || "audio/webm" });
    const formData = new FormData();
    const filename = (mimeType || "audio/webm").includes("wav")
      ? "audio.wav"
      : "audio.webm";
    formData.append("file", blob, filename);
    formData.append("model", modelToUse);
    formData.append(
      "prompt",
      languageHint === "kn"
        ? "ಕರ್ನಾಟಕ ರಾಜ್ಯ ಪೊಲೀಸ್ ಪೋರ್ಟಲ್, ಪೊಲೀಸ್ ಪ್ರಕರಣಗಳು, ಎಫ್‌ಐಆರ್‌ಗಳು, ಅಪರಾಧ ದಾಖಲೆಗಳು, ಇಂದು ದಾಖಲಾದ ಒಟ್ಟು ಪ್ರಕರಣಗಳು, ತನಿಖೆ, ಠಾಣೆಗಳು ಮತ್ತು ವರದಿಗಳು."
        : "Karnataka State Police Portal, police cases, FIRs, crime records, total cases recorded today, investigation, stations, reports.",
    );
    formData.append("temperature", "0");
    if (languageHint) formData.append("language", languageHint);
    formData.append("response_format", "json");

    const response = await fetch(GROQ_WHISPER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`Groq Whisper HTTP ${response.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await response.json();
    return (data.text || "").trim();
  }

  // Try each Groq key until one works
  let lastError = null;
  for (const apiKey of GROQ_KEYS) {
    try {
      let transcript = await callWhisper(apiKey, model, whisperLang);

      // If forced Kannada hint produced Hindi, retry without any hint
      if (looksLikeWrongLanguage(transcript, lang)) {
        console.log(`[STT] Got Hindi output for Kannada request, retrying without language hint...`);
        const retry = await callWhisper(apiKey, model, undefined);
        if (retry) transcript = retry;
      }

      console.log(`[STT] Result: "${transcript.slice(0, 100)}" (model=${model})`);

      if (!transcript) {
        throw Object.assign(new Error("No speech detected."), { status: 422 });
      }

      return {
        transcript,
        confidence: 0.9,
        language: lang || "en",
        service: "groq-whisper",
      };
    } catch (error) {
      lastError = error;
      if (error?.status === 422) throw error;
      if (String(error?.message || "").includes("HTTP 429")) throw error;
      console.warn(`[STT] Groq key failed:`, error.message);
    }
  }

  throw lastError || new Error("All Groq Whisper attempts failed.");
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

async function handleSttRequest(req, res, next) {
  const url = new URL(req.url || "/", "http://local-stt");
  if (url.pathname !== "/api/speech-to-text") { next(); return; }

  // --- Health check (unauthenticated) ---
  if (req.method === "GET") {
    sendJson(res, 200, {
      ok: STT_ENABLED,
      configured: STT_ENABLED,
      service: STT_ENABLED ? "groq-whisper" : "none",
    });
    return true;
  }

  // --- Transcription request (authenticated) ---
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed." });
    return true;
  }

  const session = requireSession(req, res);
  if (!session) return true;

  const rate = checkSpeechRateLimit(session.employeeId);
  if (!rate.ok) {
    res.setHeader("Retry-After", String(rate.retryAfterSeconds));
    sendJson(res, 429, {
      ok: false,
      error: `Too many requests. Try again in ${rate.retryAfterSeconds} seconds.`,
    });
    return true;
  }

  try {
    const { audio, lang, mimeType } = await readBody(req);

    if (!audio || typeof audio !== "string") {
      sendJson(res, 400, { ok: false, error: "audio (base64) is required." });
      return true;
    }

    // Validate base64 format
    const base64Clean = audio.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]+=*$/.test(base64Clean)) {
      sendJson(res, 400, { ok: false, error: "Invalid base64 audio data." });
      return true;
    }

    // Bound a delayed/backoff batch while allowing long speech recordings.
    if (base64Clean.length > 2_800_000) {
      sendJson(res, 413, {
        ok: false,
        error: "Audio batch is too long. Please stop and try again.",
      });
      return true;
    }

    const result = await transcribeAudio(
      base64Clean,
      lang || "en",
      mimeType || "audio/webm",
    );

    sendJson(res, 200, { ok: true, ...result });
    return true;
  } catch (error) {
    console.error("[STT] Transcription failed.", error?.message || error);
    sendJson(res, error?.status || 500, {
      ok: false,
      error: error?.status
        ? error.message
        : "Speech-to-text is temporarily unavailable: " + (error?.message || String(error)),
    });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

function sttPlugin() {
  return {
    name: "stt-speech-to-text",
    configureServer(server) {
      server.middlewares.use(handleSttRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleSttRequest);
    },
  };
}

export default sttPlugin;
