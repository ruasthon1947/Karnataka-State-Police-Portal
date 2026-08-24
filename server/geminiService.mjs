import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { GoogleGenAI } from "@google/genai";
import { readExplicitTabRecords } from "./sheetsStore.mjs";
import { casesFromGoogle } from "./googleSheets.mjs";

// In-memory chat history storage (Replace with your database collection/table as needed)
const chatHistoryStore = new Map();

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

const GROQ_KEYS = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

const FALLBACK_GEMINI_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash-lite"];
const FALLBACK_GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

const STOP_WORDS = new Set([
  "give", "details", "complete", "about", "this", "case", "cases", "bearing",
  "number", "with", "total", "recorded", "today", "show", "what", "are",
  "have", "from", "that", "which", "will", "would", "could", "should",
  "output", "kannada", "english", "please", "tell", "need", "only", "also",
  "list", "all", "the", "for", "any", "in", "at", "of", "is", "and", "or"
]);
const TIME_AND_QUERY_WORDS = new Set([
  ...STOP_WORDS,
  "fir", "firs", "crime", "crimes", "registered", "registration",
  "today", "week", "weeks", "weekly", "month", "months", "monthly",
  "year", "years", "yearly", "past", "last", "recent", "recently",
]);

function normalizeLocationOrTerm(term) {
  const t = String(term || "").toLowerCase().trim();
  if (t === "whitefiled" || t === "whitefield") return "whitefield";
  if (t === "koramangla" || t === "koramangala") return "koramangala";
  if (t === "indranagar" || t === "indiranagar") return "indiranagar";
  if (t === "basavangudi" || t === "basavanagudi") return "basavanagudi";
  return t;
}

/**
 * Normalizes crime numbers for flexible matching.
 * E.g., "0011/2026", "CR-0011/2026", and "11/2026" all normalize to "11/2026".
 */
export function normalizeCrimeNo(str) {
  if (!str) return "";
  const cleaned = String(str)
    .trim()
    .toUpperCase()
    .replace(/^CR-?/i, "");

  const parts = cleaned.split("/");
  if (parts.length === 2) {
    const seq = parts[0].replace(/^0+/, "");
    return `${seq}/${parts[1]}`;
  }
  return cleaned;
}

const DEFAULT_CHAT_OUTPUT_TOKENS = 900;
const CONTINUATION_OUTPUT_TOKENS = 500;

function joinContinuation(first, second) {
  const left = String(first || "").trimEnd();
  const right = String(second || "").trimStart();
  if (!left) return right;
  if (!right) return left;
  return `${left}\n${right}`;
}

function continuationPrompt(originalPrompt, partialAnswer) {
  return `${originalPrompt}

The previous response below was cut off by the output limit:
--- partial response ---
${partialAnswer}
--- end partial response ---

Continue exactly where it stopped. Do not repeat any completed text. Finish the answer concisely.`;
}

async function generateWithGroq(prompt, apiKey, maxTokens = DEFAULT_CHAT_OUTPUT_TOKENS, isJson = false) {
  for (const model of FALLBACK_GROQ_MODELS) {
    try {
      console.log(`[Copilot Engine] Calling Groq model '${model}'...`);
      const requestCompletion = (requestPrompt, outputTokens) =>
        fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "user", content: requestPrompt }],
            temperature: 0.0,
            max_completion_tokens: outputTokens,
            reasoning_effort: "low",
            reasoning_format: "hidden",
            ...(isJson ? { response_format: { type: "json_object" } } : {})
          })
        });

      const res = await requestCompletion(prompt, maxTokens);

      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        const finishReason = data.choices?.[0]?.finish_reason;
        if (!text) throw new Error("Groq returned an empty response.");
        if (finishReason !== "length") return text.trim();
        if (isJson) throw new Error("Groq JSON response reached its output limit.");

        const continuationResponse = await requestCompletion(
          continuationPrompt(prompt, text),
          CONTINUATION_OUTPUT_TOKENS,
        );
        if (!continuationResponse.ok) {
          throw new Error(`Groq continuation failed with HTTP ${continuationResponse.status}.`);
        }
        const continuationData = await continuationResponse.json();
        const continuation = continuationData.choices?.[0]?.message?.content;
        if (!continuation) throw new Error("Groq returned an empty continuation.");
        return joinContinuation(text, continuation);
      } else {
        const errJson = await res.json().catch(() => ({}));
        console.warn(`[Copilot Engine] Groq model '${model}' HTTP ${res.status}:`, errJson?.error?.message || res.statusText);
      }
    } catch (e) {
      console.warn(`[Copilot Engine] Groq model '${model}' error:`, e.message);
    }
  }
  throw new Error("All Groq models failed.");
}

async function generateWithFallback(
  fullPrompt,
  maxTokens = DEFAULT_CHAT_OUTPUT_TOKENS,
  isJson = false,
  attachment = null,
) {
  let lastError = null;

  for (const modelName of FALLBACK_GEMINI_MODELS) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
      const key = GEMINI_KEYS[i];
      try {
        const ai = new GoogleGenAI({ apiKey: key });
        const config = { maxOutputTokens: maxTokens };
        if (isJson) {
          config.responseMimeType = "application/json";
        }

        const requestCompletion = (contents, outputTokens) => ai.models.generateContent(
          {
            model: modelName,
            contents: attachment?.data
              ? [
                  {
                    inlineData: {
                      mimeType: attachment.mimeType,
                      data: attachment.data,
                    },
                  },
                  { text: contents },
                ]
              : contents,
            config: { ...config, maxOutputTokens: outputTokens }
          },
          { timeout: 30000 }
        );
        const response = await requestCompletion(fullPrompt, maxTokens);
        const text = String(response.text || "").trim();
        const finishReason = response.candidates?.[0]?.finishReason;
        if (!text) throw new Error("Gemini returned an empty response.");
        if (finishReason !== "MAX_TOKENS") return text;
        if (isJson) throw new Error("Gemini JSON response reached its output limit.");

        const continuationResponse = await requestCompletion(
          continuationPrompt(fullPrompt, text),
          CONTINUATION_OUTPUT_TOKENS,
        );
        const continuation = String(continuationResponse.text || "").trim();
        if (!continuation) throw new Error("Gemini returned an empty continuation.");
        return joinContinuation(text, continuation);
      } catch (err) {
        console.warn(`[Copilot Engine] ⚠️ Gemini Key #${i + 1} failed on '${modelName}' (${err.status || 'Quota/404'}). Retrying...`);
        lastError = err;
      }
    }
  }

  if (attachment?.data) {
    throw new Error(`All multimodal AI providers failed. Last error: ${lastError?.message}`);
  }

  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const key = GROQ_KEYS[i];
    try {
      console.log(`[Copilot Engine] 🚀 Executing request via Groq Engine Key #${i + 1}...`);
      return await generateWithGroq(fullPrompt, key, maxTokens, isJson);
    } catch (err) {
      console.warn(`[Copilot Engine] ⚠️ Groq Key #${i + 1} failed:`, err.message);
      lastError = err;
    }
  }

  throw new Error(`All AI provider keys and models failed. Last error: ${lastError?.message}`);
}

export function parseCaseDate(dateStr) {
  if (!dateStr) return null;
  const str = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.substring(0, 10);
  }
  const parts = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (parts) {
    const day = parts[1].padStart(2, "0");
    const month = parts[2].padStart(2, "0");
    const year = parts[3];
    return `${year}-${month}-${day}`;
  }
  return str.substring(0, 10);
}

export function findMatchingCases(question, allCases) {
  if (!question || !allCases || allCases.length === 0) return [];
  const qLower = String(question).toLowerCase().trim();
  const qClean = qLower.replace(/[^\w\/\-\s]/g, " ");
  const queryCrimeNumbers = (qLower.match(/(?:cr-?)?\d{1,4}\/\d{4}/gi) || [])
    .map((value) => normalizeCrimeNo(value).toLowerCase());

  const matched = new Set();

  for (const c of allCases) {
    if (!c) continue;
    const caseNo = String(c.CaseNo || "").toLowerCase().trim();
    const crimeNo = String(c.CrimeNo || "").toLowerCase().trim();
    const caseMasterId = String(c.CaseMasterID || "").toLowerCase().trim();
    const normCrime = normalizeCrimeNo(c.CrimeNo).toLowerCase();

    if (caseNo && (qLower.includes(caseNo) || qClean.includes(caseNo))) {
      matched.add(c);
      continue;
    }

    if (caseNo.startsWith("fir/")) {
      const bareNo = caseNo.replace(/^fir\//i, "");
      if (bareNo && (qLower.includes(bareNo) || qClean.includes(bareNo))) {
        matched.add(c);
        continue;
      }
    }

    if (caseMasterId) {
      const re = new RegExp(`\\b${caseMasterId}\\b`, "i");
      if (re.test(qClean)) {
        matched.add(c);
        continue;
      }
    }

    if (crimeNo && (qLower.includes(crimeNo) || qClean.includes(crimeNo))) {
      matched.add(c);
      continue;
    }

    if (normCrime && normCrime.length >= 4) {
      if (queryCrimeNumbers.includes(normCrime)) {
        matched.add(c);
        continue;
      }
    }
  }

  if (matched.size > 0) return Array.from(matched);

  const numbersInQuery = qClean.match(/\b\d{3,16}\b/g) || [];
  if (numbersInQuery.length > 0) {
    for (const c of allCases) {
      if (!c) continue;
      const caseNo = String(c.CaseNo || "").toLowerCase().trim();
      const caseMasterId = String(c.CaseMasterID || "").toLowerCase().trim();
      const crimeNo = String(c.CrimeNo || "").toLowerCase().trim();

      for (const num of numbersInQuery) {
        if (num === "2026") continue;
        if (caseMasterId === num || caseNo === num || caseNo.endsWith(`/${num}`) || crimeNo === num || crimeNo.endsWith(`/${num}`)) {
          matched.add(c);
        }
      }
    }
    if (matched.size > 0) return Array.from(matched);
  }

  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  const isTodayQuery = qLower.includes("today");
  const isWeekQuery = qLower.includes("this week") || qLower.includes("past week") || qLower.includes("last week") || qLower.includes("weekly");
  const isMonthQuery = qLower.includes("this month") || qLower.includes("past month") || qLower.includes("last month") || qLower.includes("monthly");

  if (isTodayQuery || isWeekQuery || isMonthQuery) {
    let startDateStr = todayStr;
    if (isWeekQuery) {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      startDateStr = d.toISOString().split("T")[0];
    } else if (isMonthQuery) {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      startDateStr = d.toISOString().split("T")[0];
    }

    const dateMatches = [];
    for (const c of allCases) {
      if (!c) continue;
      const parsedDate = parseCaseDate(c.CrimeRegisteredDate || c.IncidentFromDate);
      if (parsedDate && parsedDate >= startDateStr && parsedDate <= todayStr) {
        dateMatches.push(c);
      }
    }

    const filterTerms = qClean
      .split(/\s+/)
      .map(normalizeLocationOrTerm)
      .filter((term) => term.length > 2 && !TIME_AND_QUERY_WORDS.has(term));
    if (filterTerms.length === 0) return dateMatches;
    return dateMatches.filter((record) => {
      const rowText = Object.values(record).join(" ").toLowerCase();
      return filterTerms.every((term) => rowText.includes(term));
    });
  }

  const tokens = qClean.split(/\s+/).map(normalizeLocationOrTerm).filter(t => t.length > 2 && !STOP_WORDS.has(t));
  if (tokens.length > 0) {
    for (const c of allCases) {
      const rowStr = Object.values(c).join(" ").toLowerCase();
      if (tokens.every(term => {
        if (term === "kidnapping" || term === "abduction") {
          return rowStr.includes("kidnapping") || rowStr.includes("abduction");
        }
        return rowStr.includes(term);
      })) {
        matched.add(c);
      }
    }
    if (matched.size > 0) return Array.from(matched);

    for (const c of allCases) {
      const rowStr = Object.values(c).join(" ").toLowerCase();
      if (tokens.some(term => {
        if (term === "kidnapping" || term === "abduction") {
          return rowStr.includes("kidnapping") || rowStr.includes("abduction");
        }
        return rowStr.includes(term);
      })) {
        matched.add(c);
      }
    }
    if (matched.size > 0) return Array.from(matched);
  }

  return [];
}

const FIR_DRAFT_FIELDS = [
  "CaseMasterID", "CaseNo", "CrimeNo", "CrimeRegisteredDate",
  "CrimeHead", "CrimeSubHead", "PoliceStation", "PoliceStationType",
  "District", "Court", "EmployeeID", "Officer", "OfficerRank",
  "OfficerDesignation", "Status", "CaseCategory", "Gravity",
  "AccusedCount", "AccusedNames", "VictimCount", "VictimNames",
  "Complainant", "ArrestCount", "ChargesheetCount", "LatestChargesheetDate",
  "ChargesheetStatus", "Acts", "Sections", "InfoReceivedPSDate",
  "IncidentFromDate", "IncidentToDate", "Latitude", "Longitude",
  "BriefFacts", "FiledBy",
];

const FIR_OPTION_FIELDS = new Set([
  "CrimeHead", "CrimeSubHead", "PoliceStation", "PoliceStationType",
  "District", "Court", "Officer", "OfficerRank", "OfficerDesignation",
  "Status", "CaseCategory", "Gravity", "Acts", "Sections",
  "ChargesheetStatus",
]);

function firScalar(value) {
  if (Array.isArray(value)) return value.map(firScalar).filter(Boolean).join("; ");
  if (value == null || typeof value === "object") return "";
  return String(value).trim().replace(/\s+/g, " ");
}

function normalizedOptionKey(value) {
  return firScalar(value).toLocaleLowerCase().replace(/[^a-z0-9\u0C80-\u0CFF]+/g, " ").trim();
}

function alignWithAllowedValue(field, value, context) {
  const cleaned = firScalar(value);
  if (!cleaned || !FIR_OPTION_FIELDS.has(field)) return cleaned;
  const allowed = Array.isArray(context?.allowedValues?.[field])
    ? context.allowedValues[field]
    : [];
  if (allowed.length === 0) return cleaned;
  const wanted = normalizedOptionKey(cleaned);
  return allowed.find((option) => normalizedOptionKey(option) === wanted) || cleaned;
}

function normalizeIsoDate(value) {
  const cleaned = firScalar(value);
  if (!cleaned) return "";
  const match = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[0]
    ? ""
    : match[0];
}

function normalizeIsoDateTime(value) {
  const cleaned = firScalar(value);
  if (!cleaned) return "";
  const match = cleaned.match(
    /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!match || !normalizeIsoDate(match[1])) return "";
  const hour = Number(match[2] || "00");
  const minute = Number(match[3] || "00");
  const second = Number(match[4] || "00");
  if (hour > 23 || minute > 59 || second > 59) return "";
  return `${match[1]} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function normalizeCount(value) {
  const parsed = Number.parseInt(firScalar(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : "0";
}

function normalizeCoordinate(value, min, max) {
  const cleaned = firScalar(value);
  if (!cleaned) return "";
  const number = Number(cleaned);
  return Number.isFinite(number) && number >= min && number <= max
    ? String(number)
    : "";
}

function listCount(value) {
  if (!value) return "0";
  return String(value.split(";").map((item) => item.trim()).filter(Boolean).length);
}

export function normalizeFirDraft(rawDraft, complaint, context = {}) {
  const source = rawDraft && typeof rawDraft === "object" && !Array.isArray(rawDraft)
    ? rawDraft
    : {};
  const result = Object.fromEntries(FIR_DRAFT_FIELDS.map((field) => [field, ""]));
  for (const field of FIR_DRAFT_FIELDS) {
    result[field] = alignWithAllowedValue(field, source[field], context).slice(
      0,
      field === "BriefFacts" ? 4_000 : 1_000,
    );
  }

  const defaults = context?.defaults || {};
  for (const field of [
    "CrimeRegisteredDate", "PoliceStation", "PoliceStationType", "District",
    "EmployeeID", "Officer", "OfficerRank", "OfficerDesignation", "Status",
    "CaseCategory", "Gravity", "FiledBy",
  ]) {
    if (!result[field]) result[field] = firScalar(defaults[field]).slice(0, 200);
  }

  result.CrimeRegisteredDate =
    normalizeIsoDate(result.CrimeRegisteredDate) || new Date().toISOString().slice(0, 10);
  result.LatestChargesheetDate = normalizeIsoDate(result.LatestChargesheetDate);
  for (const field of ["InfoReceivedPSDate", "IncidentFromDate", "IncidentToDate"]) {
    result[field] = normalizeIsoDateTime(result[field]);
  }
  result.Latitude = normalizeCoordinate(result.Latitude, -90, 90);
  result.Longitude = normalizeCoordinate(result.Longitude, -180, 180);
  result.ArrestCount = normalizeCount(result.ArrestCount);
  result.ChargesheetCount = normalizeCount(result.ChargesheetCount);
  result.AccusedNames = firScalar(result.AccusedNames);
  result.VictimNames = firScalar(result.VictimNames);
  result.AccusedCount = listCount(result.AccusedNames);
  result.VictimCount = listCount(result.VictimNames);
  result.CaseCategory = result.CaseCategory || "FIR";
  result.Status = result.Status || "Under Investigation";
  result.Gravity = result.Gravity || "Non-Heinous";
  result.ChargesheetStatus = result.ChargesheetStatus || "Pending";
  result.BriefFacts = result.BriefFacts || firScalar(complaint).slice(0, 4_000);

  if (result.IncidentFromDate && result.IncidentToDate &&
      result.IncidentToDate < result.IncidentFromDate) {
    result.IncidentToDate = result.IncidentFromDate;
  }
  return result;
}

export async function generateFirDraft(unstructuredText, context = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You extract structured data for a Karnataka Police FIR draft.
Return one complete valid JSON object only, with every key listed below. Use strings for every value.

Rules:
- Today is ${today}.
- Extract facts from the complaint accurately. Never invent IDs, case/crime numbers, coordinates, officer details, station, court, dates, arrests, or chargesheet activity.
- Infer a concise CrimeHead and CrimeSubHead from the incident. Use the closest supplied allowed value when one clearly matches.
- Acts and Sections may be inferred only when reasonably supported by the facts; keep them concise and semicolon-separated.
- Keep distinct roles correct: Complainant is the reporter, VictimNames are harmed persons, and AccusedNames are alleged offenders. Use semicolon-separated names. Use "Unknown" only when an offender exists but is unidentified.
- Preserve the complaint's facts in BriefFacts as a neutral, detailed 2-5 sentence summary. Do not add evidence or allegations absent from the complaint.
- Use YYYY-MM-DD for date fields and YYYY-MM-DD HH:MM:SS for date-time fields. Leave an unknown value empty.
- Initial FIR defaults are ArrestCount "0", ChargesheetCount "0", LatestChargesheetDate "", ChargesheetStatus "Pending", Status "Under Investigation", and CaseCategory "FIR".

Allowed live Google Sheets values (bounded):
${JSON.stringify(context.allowedValues || {})}

Authorized officer/form defaults:
${JSON.stringify(context.defaults || {})}

Required keys:
${JSON.stringify(FIR_DRAFT_FIELDS)}

Complaint:
${JSON.stringify(String(unstructuredText || "").slice(0, 30_000))}`;

  const rawDraft = await generateWithFallback(prompt, 1500, true);
  try {
    return normalizeFirDraft(parseFirDraftJson(rawDraft), unstructuredText, context);
  } catch {
    const repairedDraft = await generateWithFallback(
      `Return a valid JSON object only. Repair the following FIR draft without changing its facts. Escape all quotes and line breaks inside string values.\n\n${rawDraft}`,
      1500,
      true,
    );
    return normalizeFirDraft(parseFirDraftJson(repairedDraft), unstructuredText, context);
  }
}

function parseFirDraftJson(value) {
  const text = String(value || "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("AI did not return a JSON object.");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("AI did not return a JSON object.");
  }
  return parsed;
}

export function compactConversationHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-6)
    .filter((message) =>
      message &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string"
    )
    .map((message) => ({
      role: message.role,
      content: message.content.replace(/\s+/g, " ").trim().slice(0, 800),
    }))
    .filter((message) => message.content);
}

function conversationText(history) {
  if (!history.length) return "No earlier conversation.";
  return history
    .map((message) => `${message.role === "user" ? "Officer" : "Assistant"}: ${message.content}`)
    .join("\n");
}

function searchQuestionWithHistory(question, history) {
  const looksLikeFollowUp =
    /\b(it|its|that|this|those|these|same|above|former|latter)\b/i.test(question) ||
    /^(and|also|what about|how about|who|where|when|why)\b/i.test(question.trim());
  if (!looksLikeFollowUp || history.length === 0) return question;
  return `${history.slice(-2).map((message) => message.content).join(" ")} ${question}`;
}

export function isCaseRecordQuestion(question) {
  const hasRecordIdentifier =
    /(?:cr-?)?\d{1,4}\/\d{4}|\b\d{5,16}\b/i.test(question);
  const looksLikeGeneralKnowledge =
    /^(what (?:is|are)|explain|define|how (?:does|do|to)|why)\b/i.test(question.trim());
  if (looksLikeGeneralKnowledge && !hasRecordIdentifier) return false;
  return /\b(fir|crime\s*(?:no|number)?|case\s*(?:no|number|record|status|details?)?|complainant|accused|victim|police station|chargesheet|charge sheet|court|investigation|registered|disposal rate|offence|incident)\b/i
    .test(question);
}

// ==========================================
// CHAT SESSION & HISTORY MANAGEMENT HELPERS
// ==========================================

/**
 * Saves or updates a user chat session.
 */
export async function saveChatSession(userId, sessionId, messages, title = "New Session") {
  if (!userId || !sessionId) return null;
  const userKey = String(userId);
  const userSessions = chatHistoryStore.get(userKey) || [];
  
  const updatedTitle = messages.length > 0 && messages[0].content 
    ? messages[0].content.slice(0, 30) + (messages[0].content.length > 30 ? "..." : "")
    : title;

  const existingIdx = userSessions.findIndex((s) => s.id === sessionId);
  const sessionData = {
    id: sessionId,
    userId: userKey,
    title: updatedTitle,
    messages,
    updatedAt: new Date().toISOString()
  };

  if (existingIdx >= 0) {
    userSessions[existingIdx] = sessionData;
  } else {
    userSessions.unshift(sessionData);
  }

  chatHistoryStore.set(userKey, userSessions);
  return sessionData;
}

/**
 * Gets all saved sessions for a given user.
 */
export async function getUserChatHistory(userId) {
  if (!userId) return [];
  return chatHistoryStore.get(String(userId)) || [];
}

/**
 * Gets a specific session by ID.
 */
export async function getSessionById(userId, sessionId) {
  const userSessions = await getUserChatHistory(userId);
  return userSessions.find((s) => s.id === sessionId) || null;
}

/**
 * Deletes a session by ID.
 */
export async function deleteChatSession(userId, sessionId) {
  const userKey = String(userId);
  const userSessions = chatHistoryStore.get(userKey) || [];
  const filtered = userSessions.filter((s) => s.id !== sessionId);
  chatHistoryStore.set(userKey, filtered);
  return true;
}

export async function handleChatQuery({
  question,
  role,
  stationId,
  employeeId,
  language,
  history,
  attachment,
  sessionId,
  userId
}) {
  try {
    if (String(question || "").toLowerCase().includes("extract fir details into json format")) {
      return JSON.stringify(await generateFirDraft(question));
    }

    const recentHistory = compactConversationHistory(history);
    const searchQuestion = searchQuestionWithHistory(question, recentHistory);
    const asksForCaseRecords = isCaseRecordQuestion(searchQuestion);
    const isKannada = language === "kn" || /[\u0C80-\u0CFF]/.test(question || "");
    const languageInstruction = isKannada
      ? "Respond completely and exclusively in Kannada."
      : "Respond completely and exclusively in English.";
    const attachmentInstruction = attachment
      ? attachment.content
        ? `The officer attached ${JSON.stringify(attachment.name)} (${attachment.mimeType}).
Use only the relevant portions of this bounded extracted text:
--- attachment text ---
${attachment.content}
--- end attachment text ---`
        : `The officer attached ${JSON.stringify(attachment.name)} (${attachment.mimeType}) as multimodal input.
Inspect it directly and answer only what was asked. Do not transcribe the entire file unless explicitly requested.`
      : "No file is attached.";

    let answer = "";

    if (!asksForCaseRecords) {
      const generalPrompt = `You are the Karnataka Police Copilot for authorized officers.
${languageInstruction}
Be direct, well-structured, accurate, and complete. Prefer a concise answer, but do not stop mid-sentence or omit a part explicitly requested by the officer.
Give a useful answer from general knowledge. Do not invent or imply access to a specific case record. For legal or operational guidance, distinguish general information from an official legal determination.

Recent conversation:
${conversationText(recentHistory)}

${attachmentInstruction}

Current officer question: ${JSON.stringify(question)}`;

      answer = await generateWithFallback(
        generalPrompt,
        question.length > 300 ? 1100 : 800,
        false,
        attachment,
      );
    } else {
      const [caseMasterRows, accusedRows, complainantRows, consolidatedData] = await Promise.all([
        readExplicitTabRecords("CaseMaster").catch(() => []),
        readExplicitTabRecords("Accused").catch(() => []),
        readExplicitTabRecords("ComplainantDetails").catch(() => []),
        casesFromGoogle().catch(() => ({ rows: [] }))
      ]);

      const sourceCases = consolidatedData.rows && consolidatedData.rows.length > 0
        ? consolidatedData.rows
        : caseMasterRows;
      const allCases = sourceCases;

      let contextualRows = findMatchingCases(searchQuestion, allCases);
      const matchingCount = contextualRows.length;

      if (matchingCount === 0) {
        answer = language === "kn"
          ? `ಗೌರವಾನ್ವಿತ ಅಧಿಕಾರಿಗಳೇ, ನಿಮ್ಮ ಅಧಿಕಾರ ವ್ಯಾಪ್ತಿಯಲ್ಲಿ ಈ ಅವಧಿಗೆ/ವಿನಂತಿಗೆ ("${question}") ಸಂಬಂಧಿಸಿದಂತೆ **0** ಪ್ರಕರಣಗಳು ದಾಖಲಾಗಿವೆ (ಒಟ್ಟು ಸಿಸ್ಟಮ್ ಪ್ರಕರಣಗಳು: ${allCases.length}).`
          : `Officer, based on verified database records, there are currently **0** cases registered matching your request ("${question}"). (Total system cases: ${allCases.length}).`;
      } else {
        const asksForComplainant = /\bcomplainant\b/i.test(question || "");
        const asksForAccused = /\baccused|\baccuse[d]?\b/i.test(question || "");

        if (matchingCount === 1 && asksForComplainant && asksForAccused) {
          const record = contextualRows[0];
          const reference = record.CrimeNo || record.CaseNo || record.CaseMasterID || "Matched case";
          const complainant = record.Complainant || "Not recorded";
          const accused = record.AccusedNames || "Not recorded";
          answer = `📌 **Case:** ${reference}\n👤 **Complainant:** ${complainant}\n🚨 **Accused:** ${accused}`;
        } else {
          contextualRows = contextualRows.slice(0, 3).map(cCase => {
            if (!cCase) return {};
            const caseId = String(cCase.CaseMasterID || "").trim();
            
            const relatedAccusedList = accusedRows
              .filter(a => a && String(a.CaseMasterID || "").trim() === caseId)
              .map(a => `${a.AccusedName || "Unknown"}${a.AgeYear ? ` (${a.AgeYear}y)` : ""}`)
              .join(", ");

            const relatedComplainants = complainantRows
              .filter(c => c && String(c.CaseMasterID || "").trim() === caseId)
              .map(c => `${c.ComplainantName || "N/A"}${c.AgeYear ? ` (${c.AgeYear}y)` : ""}`)
              .join(", ");
            
            return {
              ...cCase,
              LinkedAccusedProfiles: cCase.AccusedNames || relatedAccusedList || "None listed.",
              TargetComplainantDetails: cCase.Complainant || relatedComplainants || "None listed."
            };
          });

          const finalFilteredRows = contextualRows;

          const IMPORTANT_KEYS = [
            "CaseNo", "CrimeNo", "CrimeHead", "CrimeSubHead", "Gravity",
            "PoliceStation", "Status", "Court", "ChargesheetStatus",
            "IncidentFromDate", "CrimeRegisteredDate", "Complainant", "AccusedNames",
            "VictimNames", "Acts", "Sections", "Officer", "EmployeeID", "BriefFacts"
          ];

          const formattedContext = finalFilteredRows.map((row, i) => {
            const parts = [];
            for (const k of IMPORTANT_KEYS) {
              if (k in row) {
                let v = String(row[k] ?? "").trim();
                if (!v || v === "N/A" || v === "None listed.") continue;
                v = v.replace(/\s+/g, " ").slice(0, 500);
                parts.push(`${k}: ${v}`);
              }
            }
            return `[Case ${i + 1}] ${parts.join(" | ")}`;
          }).join("\n");

          const totalSystemCount = allCases.length;
          const todayStr = new Date().toISOString().split("T")[0];
          const todayCount = allCases.filter(r => String(r.CrimeRegisteredDate || "").startsWith(todayStr)).length;

          const dataInstruction = `Verified database facts are provided below. Use only these facts for case-specific claims.
Total system cases: ${totalSystemCount}. Registered today: ${todayCount}. Full matching count: ${matchingCount}.
Only ${finalFilteredRows.length} representative matching record(s) are included to control token usage. If there are more matches, state the full count and clearly say that only the first ${finalFilteredRows.length} are shown.
Answer the officer's actual question directly. Include only relevant fields; do not force a fixed template, invent missing values, or display bracket placeholders.

Verified records:
${formattedContext}`;

          const prompt = `You are the Karnataka Police Copilot for authorized officers.
${languageInstruction}
Be direct, well-structured, and complete. Prefer a concise answer, but do not stop mid-sentence or omit a part explicitly requested by the officer.

Recent conversation:
${conversationText(recentHistory)}

${attachmentInstruction}

${dataInstruction}

Current officer question: ${JSON.stringify(question)}`;

          const outputBudget = matchingCount > 1 || question.length > 300 ? 1100 : 800;
          answer = await generateWithFallback(prompt, outputBudget, false, attachment);
        }
      }
    }

    // Auto-save history if session and user context are available
    if (userId && sessionId) {
      const updatedMessages = [
        ...(history || []),
        { role: "user", content: question },
        { role: "assistant", content: answer }
      ];
      await saveChatSession(userId, sessionId, updatedMessages);
    }

    return answer;
  } catch (err) {
    console.error("[Copilot Engine] Generation failed.", err);
    throw new Error("Copilot could not complete this request.");
  }
}