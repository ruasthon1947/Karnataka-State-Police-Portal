import "dotenv/config";
import dns from "node:dns";
import { findMatchingCases, generateFirDraft, handleChatQuery } from "./geminiService.mjs";
import { casesFromGoogle } from "./googleSheets.mjs";
import { checkChatRateLimit, requireSession } from "./security.mjs";

dns.setDefaultResultOrder("ipv4first");

const MAX_BODY_BYTES = 3_000_000;
const MAX_ATTACHMENT_BYTES = 2_000_000;
const MAX_ATTACHMENT_TEXT_CHARS = 12_000;
const ALLOWED_BINARY_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const ALLOWED_TEXT_TYPES = new Set([
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

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

export function normalizeChatAttachment(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Invalid attachment."), { status: 400 });
  }

  const name = String(value.name || "attachment").trim().slice(0, 120);
  const mimeType = String(value.mimeType || "").trim().toLowerCase();
  if (ALLOWED_TEXT_TYPES.has(mimeType)) {
    const content = String(value.content || "").slice(0, MAX_ATTACHMENT_TEXT_CHARS);
    if (!content.trim()) {
      throw Object.assign(new Error("The attached text file is empty."), { status: 400 });
    }
    return { name, mimeType, content };
  }

  if (!ALLOWED_BINARY_TYPES.has(mimeType)) {
    throw Object.assign(
      new Error("Unsupported attachment type. Upload TXT, CSV, JSON, Markdown, PDF, JPG, PNG, or WebP."),
      { status: 400 },
    );
  }

  const data = String(value.data || "").trim();
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw Object.assign(new Error("Invalid attachment data."), { status: 400 });
  }
  const estimatedBytes = Math.floor((data.length * 3) / 4);
  if (estimatedBytes > MAX_ATTACHMENT_BYTES) {
    throw Object.assign(new Error("The attachment must be 2 MB or smaller."), { status: 413 });
  }
  return { name, mimeType, data };
}

export function normalizeFirDraftContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { allowedValues: {}, defaults: {} };
  }
  const allowedValues = {};
  if (value.allowedValues && typeof value.allowedValues === "object") {
    for (const [field, rawValues] of Object.entries(value.allowedValues)) {
      if (!Array.isArray(rawValues)) continue;
      allowedValues[String(field).slice(0, 60)] = rawValues
        .slice(0, 15)
        .map((item) => String(item || "").trim().replace(/\s+/g, " ").slice(0, 120))
        .filter(Boolean);
    }
  }
  const defaults = {};
  if (value.defaults && typeof value.defaults === "object") {
    for (const [field, rawValue] of Object.entries(value.defaults)) {
      defaults[String(field).slice(0, 60)] = String(rawValue || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 200);
    }
  }
  return { allowedValues, defaults };
}

export async function handleChatApi(req, res, next) {
  const url = new URL(req.url || "/", "http://local-chat");
  const isChatRequest = url.pathname === "/api/chat";
  const isFirDraftRequest = url.pathname === "/api/fir-draft";
  if (req.method !== "POST" || (!isChatRequest && !isFirDraftRequest)) {
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
    const { question, complaint, language, history, attachment, context } = await readBody(req);
    const cleanedQuestion = String(isFirDraftRequest ? complaint : question || "").trim();
    if (!cleanedQuestion) {
      sendJson(res, 400, {
        ok: false,
        error: isFirDraftRequest ? "Please enter the complaint text." : "Please enter a question.",
      });
      return;
    }
    if (cleanedQuestion.length > 30_000) {
      sendJson(res, 413, {
        ok: false,
        error: isFirDraftRequest
          ? "The complaint must be 30,000 characters or fewer."
          : "The question is too long.",
      });
      return;
    }
    if (isFirDraftRequest) {
      const draft = await generateFirDraft(
        cleanedQuestion,
        normalizeFirDraftContext(context),
      );
      sendJson(res, 200, { ok: true, draft });
      return;
    }
    const normalizedQuestion = cleanedQuestion.replace(
      /(?:CR-?)?\b\d{1,4}\/\d{4}\b/gi,
      (match) => normalizeCrimeNo(match),
    );
    // Exact fact questions are answered directly from Sheets so a model cannot
    // truncate or redact the names that the officer explicitly asked for.
    if (/\bcomplainant\b/i.test(normalizedQuestion) && /\baccused\b/i.test(normalizedQuestion)) {
      const { rows } = await casesFromGoogle();
      const matches = findMatchingCases(normalizedQuestion, rows);
      if (matches.length === 1) {
        const record = matches[0];
        const reference = record.CrimeNo || record.CaseNo || record.CaseMasterID || "Matched case";
        sendJson(res, 200, {
          ok: true,
          answer: `📌 **Case:** ${reference}\n👤 **Complainant:** ${record.Complainant || "Not recorded"}\n🚨 **Accused:** ${record.AccusedNames || "Not recorded"}`,
        });
        return;
      }
    }
    const answer = await handleChatQuery({
      question: normalizedQuestion,
      role: session.role,
      stationId: session.policeStation,
      employeeId: session.employeeId,
      language: language === "kn" ? "kn" : "en",
      history,
      attachment: normalizeChatAttachment(attachment),
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
