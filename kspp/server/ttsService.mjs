import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TTS_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";
const GEMINI_TTS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_TTS_MODEL = String(
  process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview",
).trim();
const GEMINI_TTS_VOICE = String(process.env.GEMINI_TTS_VOICE || "Kore").trim();
const TTS_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.TTS_CACHE_TTL_MS || 30 * 60 * 1000),
);
const TTS_CACHE_MAX_ENTRIES = Math.max(
  8,
  Number(process.env.TTS_CACHE_MAX_ENTRIES || 64),
);
const speechCache = new Map();
let geminiUnavailableUntil = 0;
let cloudTtsUnavailableUntil = 0;

export const PREWARM_GREETINGS = {
  en: "Hello. I'm the KSPP Copilot. How can I help you today?",
  kn: "ನಮಸ್ಕಾರ. ನಾನು ಕೆಎಸ್‌ಪಿಪಿ ಸಹಾಯಕಿ. ಇಂದು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?",
};

const VOICES = {
  en: {
    languageCode: "en-IN",
    name: String(process.env.GOOGLE_TTS_EN_VOICE || "en-IN-Neural2-A").trim(),
    speakingRate: 0.94,
  },
  kn: {
    languageCode: "kn-IN",
    name: String(process.env.GOOGLE_TTS_KN_VOICE || "kn-IN-Wavenet-A").trim(),
    speakingRate: 0.91,
  },
};

function configuredCredentials() {
  const configured = String(
    process.env.CATALYST_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      "",
  ).trim();
  const candidates = configured && !configured.startsWith("{")
    ? [path.resolve(configured)]
    : [];

  for (const fallback of [
    "service-account.json",
    "config/service-account.json",
    "local_db/service_account.json",
  ]) {
    const candidate = path.resolve(fallback);
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }

  if (configured.startsWith("{")) {
    return JSON.parse(configured);
  }
  const keyFilename = candidates.find((candidate) => fs.existsSync(candidate));
  if (!keyFilename) {
    throw new Error(
      "Google Text-to-Speech is not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON.",
    );
  }
  return JSON.parse(fs.readFileSync(keyFilename, "utf8"));
}

const base64url = (value) => Buffer.from(value).toString("base64url");
let tokenCache = { token: "", expiresAt: 0 };

async function accessToken() {
  if (tokenCache.token && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  const account = configuredCredentials();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: account.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(account.private_key, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(
      `Google authentication failed: ${data.error_description || data.error || response.statusText}`,
    );
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

export function sanitizeSpeechText(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•▪▸►]+\s+/gm, "")
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu,
      "",
    )
    .replace(/[–—―]/g, ", ")
    .replace(/\r?\n+/g, ". ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?।॥])/g, "$1")
    .trim();
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildSpeechSsml(value) {
  const clean = sanitizeSpeechText(value);
  if (!clean) return "";
  const sentences = clean
    .split(/(?<=[.!?।॥])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const markup = sentences
    .map((sentence) => `<s>${escapeXml(sentence)}</s>`)
    .join('<break time="240ms"/>');
  return `<speak>${markup}</speak>`;
}

async function synthesizeWithCloudTts(text, language) {
  if (cloudTtsUnavailableUntil > Date.now()) {
    throw new Error("Google Cloud TTS is temporarily unavailable.");
  }
  const lang = language === "kn" ? "kn" : "en";
  const voice = VOICES[lang];
  const ssml = buildSpeechSsml(text);
  if (!ssml) {
    throw Object.assign(new Error("There is no text to read aloud."), { status: 400 });
  }

  const authToken = await accessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  let response;
  try {
    response = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: { ssml },
        voice: { languageCode: voice.languageCode, name: voice.name },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: voice.speakingRate,
          pitch: -0.5,
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 403) {
      // A disabled API cannot recover during this request. Avoid repeating the
      // authentication round-trip for every sentence while the client uses its
      // online voice fallback.
      cloudTtsUnavailableUntil = Date.now() + 10 * 60_000;
    }
    throw new Error(
      `Google Text-to-Speech request failed: ${data.error?.message || response.statusText}`,
    );
  }
  const audioContent = data.audioContent;
  if (typeof audioContent !== "string" || !audioContent) {
    throw new Error("Google Text-to-Speech returned no audio.");
  }
  return {
    audio: Buffer.from(audioContent, "base64"),
    mimeType: "audio/mpeg",
    languageCode: voice.languageCode,
    voiceName: voice.name,
  };
}

function geminiApiKeys() {
  return String(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

export function pcmToWav(pcm, sampleRate = 24_000, channels = 1) {
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthesizeWithGemini(text, language) {
  if (geminiUnavailableUntil > Date.now()) {
    throw new Error("Gemini TTS is cooling down after a quota response.");
  }
  const clean = sanitizeSpeechText(text);
  if (!clean) {
    throw Object.assign(new Error("There is no text to read aloud."), { status: 400 });
  }
  const lang = language === "kn" ? "kn" : "en";
  const languageCode = lang === "kn" ? "kn-IN" : "en-IN";
  const accent = lang === "kn"
    ? "natural native Kannada as spoken in Karnataka"
    : "natural Indian English with a clear Karnataka accent";
  const prompt = [
    `Synthesize the transcript in ${accent}.`,
    "Use one consistent adult female voice that is warm, professional, conversational, and easy for Indian listeners to understand.",
    "Avoid a Western or exaggerated accent. Use natural sentence rhythm, with short pauses at commas and slightly longer pauses between sentences.",
    "Read only the transcript; do not add, remove, translate, spell out, or explain any words.",
    `Transcript: ${clean}`,
  ].join(" ");
  const keys = geminiApiKeys();
  if (!keys.length) throw new Error("Gemini TTS is not configured.");

  let lastError;
  for (let attempt = 0; attempt < Math.min(keys.length, 2); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(GEMINI_TTS_ENDPOINT, {
        method: "POST",
        headers: {
          "x-goog-api-key": keys[attempt],
          "Content-Type": "application/json",
          "Api-Revision": "2026-05-20",
        },
        body: JSON.stringify({
          model: GEMINI_TTS_MODEL,
          input: prompt,
          response_format: { type: "audio" },
          generation_config: {
            speech_config: [{
              voice: GEMINI_TTS_VOICE,
              language: languageCode,
            }],
          },
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 429) {
          const retryMatch = String(data.error?.message || "").match(
            /retry in\s+([\d.]+)s/i,
          );
          const retryMs = retryMatch
            ? Math.ceil(Number(retryMatch[1]) * 1000)
            : 60_000;
          geminiUnavailableUntil = Date.now() + Math.max(5_000, retryMs);
        }
        throw new Error(data.error?.message || `Gemini TTS failed with HTTP ${response.status}`);
      }
      const audioBlock = (data.steps || [])
        .flatMap((step) => step?.content || [])
        .find((content) => content?.type === "audio" && content?.data);
      if (!audioBlock) throw new Error("Gemini TTS returned no audio.");
      const pcm = Buffer.from(audioBlock.data, "base64");
      return {
        audio: pcmToWav(
          pcm,
          Number(audioBlock.sample_rate || 24_000),
          Number(audioBlock.channels || 1),
        ),
        mimeType: "audio/wav",
        languageCode,
        voiceName: `Gemini ${GEMINI_TTS_VOICE}`,
      };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Gemini TTS failed.");
}

async function createNaturalSpeech(text, language) {
  try {
    return await synthesizeWithGemini(text, language);
  } catch (geminiError) {
    console.warn("[TTS] Gemini voice unavailable; trying Cloud TTS.", {
      message: geminiError?.message || String(geminiError),
    });
    try {
      return await synthesizeWithCloudTts(text, language);
    } catch (cloudError) {
      throw new Error(
        `Natural voice providers failed: ${cloudError?.message || geminiError?.message || String(cloudError)}`,
      );
    }
  }
}

function speechCacheKey(text, language) {
  return crypto
    .createHash("sha256")
    .update(`${language === "kn" ? "kn" : "en"}\0${sanitizeSpeechText(text)}`)
    .digest("hex");
}

export async function synthesizeNaturalSpeech(text, language) {
  const key = speechCacheKey(text, language);
  const now = Date.now();
  const cached = speechCache.get(key);
  if (cached && cached.expiresAt > now) {
    const result = await cached.promise;
    return { ...result, audio: Buffer.from(result.audio) };
  }
  if (cached) speechCache.delete(key);

  while (speechCache.size >= TTS_CACHE_MAX_ENTRIES) {
    const oldestKey = speechCache.keys().next().value;
    if (!oldestKey) break;
    speechCache.delete(oldestKey);
  }

  const promise = createNaturalSpeech(text, language);
  speechCache.set(key, { promise, expiresAt: now + TTS_CACHE_TTL_MS });
  try {
    const result = await promise;
    return { ...result, audio: Buffer.from(result.audio) };
  } catch (error) {
    speechCache.delete(key);
    throw error;
  }
}

export async function prewarmNaturalSpeech() {
  return Promise.allSettled([
    synthesizeNaturalSpeech(PREWARM_GREETINGS.en, "en"),
    synthesizeNaturalSpeech(PREWARM_GREETINGS.kn, "kn"),
  ]);
}
