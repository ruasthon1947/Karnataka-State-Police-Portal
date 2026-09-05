import "./env.mjs";
import { checkTtsRateLimit, requireSession } from "./security.mjs";
import { synthesizeNaturalSpeech } from "./ttsService.mjs";

const MAX_BODY_BYTES = 12_000;
const MAX_TEXT_CHARS = 2_500;

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
      if (received > MAX_BODY_BYTES) {
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

export async function handleTtsRequest(req, res, next) {
  const url = new URL(req.url || "/", "http://local-tts");
  if (req.method !== "POST" || url.pathname !== "/api/text-to-speech") {
    next();
    return;
  }

  const session = requireSession(req, res);
  if (!session) return;

  const rate = checkTtsRateLimit(session.employeeId);
  if (!rate.ok) {
    res.setHeader("Retry-After", String(rate.retryAfterSeconds));
    sendJson(res, 429, {
      ok: false,
      error: `Too many voice requests. Try again in ${rate.retryAfterSeconds} seconds.`,
    });
    return;
  }

  try {
    const { text, language } = await readBody(req);
    const clean = String(text || "").trim();
    if (!clean) {
      sendJson(res, 400, { ok: false, error: "Please provide text to read aloud." });
      return;
    }
    if (clean.length > MAX_TEXT_CHARS) {
      sendJson(res, 413, {
        ok: false,
        error: `Voice responses must be ${MAX_TEXT_CHARS.toLocaleString("en-IN")} characters or fewer.`,
      });
      return;
    }

    const result = await synthesizeNaturalSpeech(clean, language);
    res.statusCode = 200;
    res.setHeader("Content-Type", result.mimeType);
    res.setHeader("Content-Length", String(result.audio.length));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-KSPP-Voice", result.voiceName);
    res.setHeader("X-KSPP-Language", result.languageCode);
    res.end(result.audio);
  } catch (error) {
    console.error("[TTS API] Synthesis failed.", {
      message: error?.message || String(error),
    });
    sendJson(res, error?.status || 502, {
      ok: false,
      error: error?.status
        ? error.message
        : "The natural voice service is temporarily unavailable.",
    });
  }
}

function ttsPlugin() {
  // Speech is requested only through the authenticated endpoint after a user
  // opens voice or asks for playback. No startup synthesis or retry timers.
  return {
    name: "kspp-natural-text-to-speech",
    configureServer(server) {
      server.middlewares.use(handleTtsRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleTtsRequest);
    },
  };
}

export default ttsPlugin;
