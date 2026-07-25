import "dotenv/config";
import dns from "node:dns";
import { handleChatQuery } from "./geminiService.mjs";
import { checkChatRateLimit, requireSession } from "./security.mjs";

dns.setDefaultResultOrder("ipv4first");

const MAX_BODY_BYTES = 50_000;
const MAX_QUESTION_LENGTH = 2_000;

export function normalizeCrimeNo(str) {
  if (!str) return "";
  const cleaned = String(str).trim().toUpperCase().replace(/^CR-?/i, "");
  const parts = cleaned.split("/");
  if (parts.length === 2) {
    const seq = parts[0].replace(/^0+/, "");
    return `${seq}/${parts[1]}`;
  }
  return cleaned;
}

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

export async function handleChatApi(req, res, next) {
  const url = new URL(req.url || "/", "http://local-chat");
  if (req.method !== "POST" || url.pathname !== "/api/chat") {
    next();
    return;
  }

  const session = requireSession(req, res);
  if (!session) return;

  const rate = checkChatRateLimit(session.employeeId);
  if (!rate.ok) {
    res.setHeader("Retry-After", String(rate.retryAfterSeconds));
    sendJson(res, 429, {
      ok: false,
      error: `Too many Copilot requests. Try again in ${rate.retryAfterSeconds} seconds.`,
    });
    return;
  }

  try {
    const { question, language } = await readBody(req);
    const cleanedQuestion = String(question || "").trim();
    if (!cleanedQuestion) {
      sendJson(res, 400, { ok: false, error: "Please enter a question." });
      return;
    }
    if (cleanedQuestion.length > MAX_QUESTION_LENGTH) {
      sendJson(res, 400, {
        ok: false,
        error: `Questions must be ${MAX_QUESTION_LENGTH} characters or fewer.`,
      });
      return;
    }

    const normalizedQuestion = cleanedQuestion.replace(
      /(?:CR-?)?\b\d{1,4}\/\d{4}\b/gi,
      (match) => normalizeCrimeNo(match),
    );
    const answer = await handleChatQuery({
      question: normalizedQuestion,
      role: session.role,
      stationId: session.policeStation,
      employeeId: session.employeeId,
      language: language === "kn" ? "kn" : "en",
    });
    sendJson(res, 200, { ok: true, answer });
  } catch (error) {
    console.error("[Chat API] Request failed.", error);
    sendJson(res, error?.status || 500, {
      ok: false,
      error: error?.status ? error.message : "Copilot is temporarily unavailable. Please try again.",
    });
  }
}

function chatPlugin() {
  return {
    name: "chat-copilot-api",
    configureServer(server) {
      server.middlewares.use(handleChatApi);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleChatApi);
    },
  };
}

export default chatPlugin;
