import "./env.mjs";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { readExplicitTabRecords } from "./sheetsStore.mjs";
import { casesFromGoogle } from "./googleSheets.mjs";

const chatHistoryStore = new Map();

const SHEETS_CACHE_TTL = 5 * 60 * 1000;
const sheetsCache = new Map(); // cacheKey -> { data, fetchedAt }

async function getCachedTabRecords(cacheKey, fetchFn, defaultValue) {
  const now = Date.now();
  const cached = sheetsCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < SHEETS_CACHE_TTL) {
    return cached.data;
  }
  try {
    const data = await fetchFn();
    sheetsCache.set(cacheKey, { data, fetchedAt: now });
    return data;
  } catch (err) {
    console.warn(`[Copilot Engine] Sheets fetch failed for '${cacheKey}':`, err.message);
    if (cached) return cached.data;
    return defaultValue;
  }
}

export function invalidateSheetsCache(cacheKey) {
  if (cacheKey) sheetsCache.delete(cacheKey);
  else sheetsCache.clear();
}

function normalizeCrimeNoUnified(str) {
  if (!str) return "";
  const cleaned = String(str)
    .trim()
    .toUpperCase()
    .replace(/^(CR|FIR)[\s\/\-]*/i, "");

  const slashMatch = cleaned.match(/^(\d{1,4})[\/\-](\d{4})$/);
  if (slashMatch) {
    let year, seq;
    if (slashMatch[1].length === 4) {
      year = slashMatch[1];
      seq = slashMatch[2];
    } else {
      year = slashMatch[2];
      seq = slashMatch[1];
    }
    return `${seq.replace(/^0+/, "") || "0"}/${year}`;
  }

  const longMatch = cleaned.match(/^(\d{4})(\d+)$/);
  if (longMatch) {
    const year = longMatch[1];
    const seq = longMatch[2];
    const yearNum = Number(year);
    if (yearNum >= 2015 && yearNum <= 2035) {
      return `${seq.replace(/^0+/, "") || "0"}/${year}`;
    }
  }

  return cleaned.replace(/^0+/, "") || "0";
}

function getGroqKeys() {
  return (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

const FALLBACK_GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

function getOpenAiKey() {
  return (process.env.OPENAI_API_KEY || "").trim();
}
const OPENAI_MODEL = "gpt-4o-mini";

const STOP_WORDS = new Set([
  "give", "details", "complete", "about", "this", "case", "cases", "bearing",
  "number", "with", "total", "recorded", "today", "show", "what", "are",
  "have", "from", "that", "which", "will", "would", "could", "should",
  "output", "kannada", "english", "please", "tell", "need", "only", "also",
  "list", "all", "the", "for", "any", "in", "at", "of", "is", "and", "or",
  // Added Kannada stop words to prevent full prompt string matching
  "ದಾಖಲಾದ", "ಪ್ರಕರಣದ", "ವಿವರಗಳನ್ನು", "ನನಗೆ", "ನೀಡಿ", "ಮಾಹಿತಿ", "ವಿವರ",
  "ತೋರಿಸಿ", "ನೀಡಿರಿ", "ಪ್ರಕರಣಗಳು", "ಪ್ರಕರಣ", "ಸಂಖ್ಯೆ", "ಕೊಡಿ", "ಬಗ್ಗೆ"
]);
const TIME_AND_QUERY_WORDS = new Set([
  ...STOP_WORDS,
  "fir", "firs", "crime", "crimes", "registered", "registration",
  "today", "week", "weeks", "weekly", "month", "months", "monthly",
  "year", "years", "yearly", "past", "last", "recent", "recently",
  // Added Kannada time and registration terms
  "ಇಂದು", "ವಾರ", "ಈ ವಾರ", "ತಿಂಗಳು", "ಈ ತಿಂಗಳು", "ವರ್ಷ", "ಈ ವರ್ಷ",
  "ಇತ್ತೀಚಿನ", "ನೋಂದಾಯಿತ", "ದಾಖಲಾದ", "ದಾಖಲಾಗಿರುವ"
]);

export function normalizeSheetRecord(row) {
  if (!row || typeof row !== "object") return {};

  const getVal = (...keys) => {
    for (const k of keys) {
      const matchKey = Object.keys(row).find(
        (rk) => rk.toLowerCase().replace(/[^a-z0-9]/g, "") === k.toLowerCase().replace(/[^a-z0-9]/g, "")
      );
      if (matchKey && row[matchKey] !== undefined && row[matchKey] !== null) {
        return String(row[matchKey]).trim();
      }
    }
    return "";
  };

  return {
    ...row,
    CaseMasterID: getVal("CaseMasterID", "CaseMaster Id", "MasterID", "ID") || row.CaseMasterID || "",
    CaseNo: getVal("CaseNo", "Case No", "Case Number", "FIR No", "FIRNo") || row.CaseNo || "",
    CrimeNo: getVal("CrimeNo", "Crime No", "Crime Number", "Crime") || row.CrimeNo || "",
    CrimeRegisteredDate: getVal("CrimeRegisteredDate", "Crime Registered Date", "Registered Date", "FIR Date") || row.CrimeRegisteredDate || "",
    IncidentFromDate: getVal("IncidentFromDate", "Incident Date", "Incident From Date") || row.IncidentFromDate || "",
    Complainant: getVal("Complainant", "Complainant Name", "ComplainantDetails") || row.Complainant || "",
    AccusedNames: getVal("AccusedNames", "Accused Name", "Accused", "Suspect") || row.AccusedNames || "",
    PoliceStation: getVal("PoliceStation", "Police Station", "Station") || row.PoliceStation || "",
    Status: getVal("Status", "Case Status") || row.Status || "",
    BriefFacts: getVal("BriefFacts", "Brief Facts", "Facts", "Summary") || row.BriefFacts || "",
  };
}

function normalizeLocationOrTerm(term) {
  const t = String(term || "").toLowerCase().trim();
  if (t === "whitefiled" || t === "whitefield") return "whitefield";
  if (t === "koramangla" || t === "koramangala") return "koramangala";
  if (t === "indranagar" || t === "indiranagar") return "indiranagar";
  if (t === "basavangudi" || t === "basavanagudi") return "basavanagudi";
  return t;
}

export function normalizeCrimeNo(str) {
  return normalizeCrimeNoUnified(str);
}

export function normalizeIdentifier(str) {
  if (!str) return "";
  const cleaned = String(str)
    .trim()
    .toUpperCase()
    .replace(/[\s\-]+/g, "")
    .replace(/^CASEMASTER/i, "")
    .replace(/^ID/i, "");
  return cleaned.replace(/^0+/, "") || "0";
}

function extractIdTokens(text) {
  const matches = String(text || "").matchAll(/\b(?:case\s*master\s*)?id[\s\-]*0*(\d+)\b/gi);
  return Array.from(matches, (m) => m[1]);
}

function looksLikeSpecificIdentifierQuery(text) {
  const t = String(text || "");
  if (/\b(?:cr|fir)[\s\-\/]*\d+/i.test(t)) return true;
  if (/\b\d{1,4}[\/\-]\d{4}\b/.test(t)) return true;
  if (/\b\d{6,}\b/.test(t)) return true;
  if (/\b(?:case\s*master\s*)?id[\s\-]*0*\d+\b/i.test(t)) return true;
  return false;
}

const SCIENTIFIC_NOTATION_RE = /^-?\d+(\.\d+)?e[+-]?\d+$/i;
function sanitizeFieldValue(key, value) {
  const v = String(value ?? "").trim();
  if (SCIENTIFIC_NOTATION_RE.test(v)) {
    console.warn(
      `[Copilot Engine] '${key}' looks corrupted by Sheets auto-number-formatting (got "${v}").`
    );
    return "⚠ data formatting issue in source sheet - verify against the original record";
  }
  return v;
}

const NAMED_FIELD_RULES = [
  { key: "Complainant", test: /\bcomplainant\b|\breporter\b/i, emoji: "👤", label: { en: "Complainant", kn: "ದೂರುದಾರ" } },
  { key: "AccusedNames", test: /\baccused\b|\bculprit\b|\bsuspect\b|\bperpetrator\b/i, emoji: "🚨", label: { en: "Accused", kn: "ಆರೋಪಿ" } },
  { key: "VictimNames", test: /\bvictim\b/i, emoji: "🧍", label: { en: "Victim", kn: "ಸಂತ್ರಸ್ತರು" } },
  {
    key: "Officer",
    test: /\bofficer\b|\binvestigating\s+officer\b|\binvestigator\b|\bio\b|\bwho\s+(?:was|is|handled)\b.*\bofficer\b|\bofficer\b.*\b(?:name|involved)\b|\btell\b.*\bofficer\b/i,
    emoji: "🧑‍✈️",
    label: { en: "Officer", kn: "ತನಿಖಾಧಿಕಾರಿ" }
  },
  {
    key: "PoliceStation",
    test: /\bpolice\s*station\b|\bstation\b|\bvenue\b|\bregistration\s+station\b|\bwhere\s+was\s+it\s+registered\b|\bwhere\s+was\s+this\s+registered\b/i,
    emoji: "🏢",
    label: { en: "Registered Police Station", kn: "ನೋಂದಾಯಿತ ಪೊಲೀಸ್ ಠಾಣೆ" },
  },
  {
    key: "PoliceStation",
    test: /\b(?:location|place)\b/i,
    emoji: "🏢",
    label: { en: "Registered Police Station", kn: "ನೋಂದಾಯಿತ ಪೊಲೀಸ್ ಠಾಣೆ" },
  },
  {
    key: "Date",
    test: /\b(?:date|registered\s+on|registration\s+date|crime\s+registered\s+date|incident\s+date|when\s+was\s+(?:it|this)\s+registered)\b/i,
    emoji: "📅",
    label: { en: "Date", kn: "ದಿನಾಂಕ" },
    fields: ["CrimeRegisteredDate", "RegisteredOn", "IncidentFromDate", "IncidentDate"],
  },
  {
    key: "IncidentLocation",
    test: /\bincident\s*location\b|\bplace\s*of\s*(?:occurrence|incident)\b|\bcrime\s*location\b|\bwhere\s*(?:did|was)\b[\s\S]*\b(?:happen|occur(?:red)?|took\s*place)\b/i,
    emoji: "📍",
    label: { en: "Incident Location", kn: "ಘಟನೆ ಸ್ಥಳ" },
    fields: ["PlaceOfOccurrence", "PlaceOfIncident", "CrimeLocation", "Location", "IncidentPlace", "Address"],
  },
];

const FULL_DETAIL_INTENT_RE =
  /(?:\b(?:complete|full|entire|every|all)\b[\s\S]*\b(?:details?|info(?:rmation)?)\b|\b(?:details?|info(?:rmation)?)\b[\s\S]*\b(?:complete|full|entire|every|all)\b|\b(?:give|show|provide|display)\b[\s\S]*\b(?:case|report|summary|details?|info(?:rmation)?)\b|\b(?:show|give|provide|display)\s+(?:the\s+)?(?:case|full\s+report|report|summary|details?|info(?:rmation)?)\b|\b(?:full\s+report|case\s+summary|summary\s+of\s+(?:the\s+)?case|case\s+details|complete\s+case|all\s+(?:the\s+)?info(?:rmation)?|all\s+info|summary)\b|ಸಂಪೂರ್ಣ|ವಿವರಗಳನ್ನು|ವಿವರ)/i;

function matchNamedFieldQuery(question) {
  const q = String(question || "");

  const simpleKeywords = {
    Complainant: /\b(complainant|reporter)\b|ದೂರುದಾರ/i,
    AccusedNames: /\b(accused|culprit|suspect|perpetrator)\b|ಆರೋಪಿ/i,
    VictimNames: /\b(victim)\b|ಸಂತ್ರಸ್ತರು/i,
    Officer: /\b(officer|investigating officer|investigator|io)\b|ತನಿಖಾಧಿಕಾರಿ/i,
    PoliceStation: /\b(police ?station|station|venue)\b|ಪೋಲೀಸ್ ?ಠಾಣೆ|ಠಾಣೆ/i,
    Date: /\b(date|registered on|registration date|incident date)\b|ದಿನಾಂಕ/i,
    IncidentLocation: /\b(incident location|place of occurrence|place of incident|crime location)\b|ಘಟನೆ ಸ್ಥಳ/i,
  };

  const matchedRules = [];
  for (const [key, regex] of Object.entries(simpleKeywords)) {
    if (regex.test(q)) {
      const rule = NAMED_FIELD_RULES.find((r) => r.key === key);
      if (rule) matchedRules.push(rule);
    }
  }

  if (matchedRules.length > 0) return matchedRules;
  if (FULL_DETAIL_INTENT_RE.test(q)) return [];

  return [];
}

function fieldValueForRule(record, rule) {
  const candidates = rule.fields || [rule.key];
  for (const key of candidates) {
    const v = sanitizeFieldValue(key, record?.[key]);
    if (v && v !== "N/A" && v !== "None listed.") return v;
  }
  return "";
}

const SHORT_ENTITY_QUESTION_RE = /^(?:who|what|which|where)\b|ಯಾರು|ಯಾವುದು|ಎಲ್ಲಿ/i;

function buildEntityContextLine(record) {
  const parts = [];
  const push = (label, value) => {
    const v = sanitizeFieldValue(label, value);
    if (v && v !== "N/A" && v !== "None listed.") parts.push(`${label}: ${v}`);
  };
  push("Complainant", record.Complainant);
  push("Accused", record.AccusedNames);
  push("Victim", record.VictimNames);
  push("Officer", record.Officer);
  push("Registered Police Station", record.PoliceStation);
  push("Date", fieldValueForRule(record, NAMED_FIELD_RULES.find((r) => r.key === "Date")));
  return parts.join(", ");
}

function cleanSingleLineEntity(raw) {
  const firstLine = String(raw || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
  return firstLine.replace(/^[\p{Emoji_Presentation}\p{So}]?\s*\**[A-Za-z\u0C80-\u0CFF ]{2,30}:\**\s*/u, "").trim();
}

async function resolveNamedFieldViaModel(record, question, isKannada) {
  if (!SHORT_ENTITY_QUESTION_RE.test(String(question || "").trim())) return "";
  const context = buildEntityContextLine(record);
  if (!context) return "";

  const prompt = `You are a strict QA and Entity Extraction Assistant for crime records.

STRICT OUTPUT FORMAT RULES:
- TARGET LANGUAGE: ${isKannada ? "KANNADA (ಕನ್ನಡ)" : "ENGLISH"}
- Respond strictly in ${isKannada ? "KANNADA (ಕನ್ನಡ)" : "ENGLISH"}.
- If the user asks for a specific field, output ONLY the value matching that field.
- Output MUST be short, direct, and contain ZERO conversational filler.

Context:
${context}

User: ${question}

OUTPUT:`;

  try {
    const raw = await generateWithFallback(prompt, 60, false, null);
    return cleanSingleLineEntity(raw);
  } catch {
    return "";
  }
}

function buildNamedFieldAnswer(record, matches, isKannada) {
  const notRecorded = isKannada ? "ದಾಖಲಾಗಿಲ್ಲ" : "Not recorded";
  const reference = record.CrimeNo || record.CaseNo || record.CaseMasterID ||
    (isKannada ? "ಹೊಂದಾಣಿಕೆಯಾದ ಪ್ರಕರಣ" : "Matched case");

  const matchedKeys = matches.map((m) => m.key);
  if (matchedKeys.length === 2 && matchedKeys.includes("Complainant") && matchedKeys.includes("AccusedNames")) {
    const complainant = record.Complainant || notRecorded;
    const accused = record.AccusedNames || notRecorded;
    return isKannada
      ? `📌 **ಪ್ರಕರಣ:** ${reference}\n👤 **ದೂರುದಾರ:** ${complainant}\n🚨 **ಆರೋಪಿ:** ${accused}`
      : `📌 **Case:** ${reference}\n👤 **Complainant:** ${complainant}\n🚨 **Accused:** ${accused}`;
  }

  const lines = matches.map((rule) => {
    const value = fieldValueForRule(record, rule) || notRecorded;
    const label = isKannada ? rule.label.kn : rule.label.en;
    return `${rule.emoji} **${label}:** ${value}`;
  });

  if (lines.length === 1) {
    return fieldValueForRule(record, matches[0]) || notRecorded;
  }
  const header = isKannada ? `📌 **ಪ್ರಕರಣ:** ${reference}` : `📌 **Case:** ${reference}`;
  return [header, ...lines].join("\n");
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

const REFUSAL_PATTERNS = [
  /^\s*i(?:['\u2019]m| am) sorry,?\s*(?:but\s+)?i\s*(?:cannot|can['\u2019]t|can not|am unable to)\s*(?:help|assist|provide|comply)/i,
  /^\s*i\s*(?:cannot|can['\u2019]t|can not)\s*(?:help|assist)\s*(?:you\s*)?with\s*(?:that|this)/i,
  /^\s*i(?:['\u2019]m| am) (?:not able to|unable to)\s/i,
  /^\s*as an ai\b/i,
  /^\s*sorry,?\s*i\s*(?:cannot|can['\u2019]t)\b/i,
];
function looksLikeRefusal(text) {
  const t = String(text || "").trim();
  return REFUSAL_PATTERNS.some((re) => re.test(t));
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
        if (!isJson && looksLikeRefusal(text)) {
          throw new Error(`Groq model '${model}' returned a safety refusal instead of an answer: ${text.slice(0, 120)}`);
        }
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
        const reason = res.status === 429 ? "RATE LIMITED (429)" : `HTTP ${res.status}`;
        console.warn(`[Copilot Engine] Groq model '${model}' ${reason}:`, errJson?.error?.message || res.statusText);
      }
    } catch (e) {
      console.warn(`[Copilot Engine] Groq model '${model}' error:`, e.message);
    }
  }
  throw new Error("All Groq models failed.");
}

async function generateWithOpenAI(prompt, apiKey, maxTokens = DEFAULT_CHAT_OUTPUT_TOKENS, isJson = false) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  console.log(`[Copilot Engine] Calling OpenAI model '${OPENAI_MODEL}'...`);
  const requestCompletion = (requestPrompt, outputTokens) =>
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: requestPrompt }],
        temperature: 0.0,
        max_tokens: outputTokens,
        ...(isJson ? { response_format: { type: "json_object" } } : {})
      })
    });

  const res = await requestCompletion(prompt, maxTokens);

  if (res.ok) {
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    const finishReason = data.choices?.[0]?.finish_reason;
    if (!text) throw new Error("OpenAI returned an empty response.");
    if (!isJson && looksLikeRefusal(text)) {
      throw new Error(`OpenAI model '${OPENAI_MODEL}' returned a safety refusal instead of an answer: ${text.slice(0, 120)}`);
    }
    if (finishReason !== "length") return text.trim();
    if (isJson) throw new Error("OpenAI JSON response reached its output limit.");

    const continuationResponse = await requestCompletion(
      continuationPrompt(prompt, text),
      CONTINUATION_OUTPUT_TOKENS,
    );
    if (!continuationResponse.ok) {
      throw new Error(`OpenAI continuation failed with HTTP ${continuationResponse.status}.`);
    }
    const continuationData = await continuationResponse.json();
    const continuation = continuationData.choices?.[0]?.message?.content;
    if (!continuation) throw new Error("OpenAI returned an empty continuation.");
    return joinContinuation(text, continuation);
  }

  const errJson = await res.json().catch(() => ({}));
  const reason = res.status === 429 ? "RATE LIMITED (429)" : `HTTP ${res.status}`;
  throw new Error(`OpenAI model '${OPENAI_MODEL}' ${reason}: ${errJson?.error?.message || res.statusText}`);
}

async function generateWithFallback(
  fullPrompt,
  maxTokens = DEFAULT_CHAT_OUTPUT_TOKENS,
  isJson = false,
  attachment = null,
) {
  if (attachment?.data) {
    throw new Error(
      "This request includes an image/PDF attachment, which needs multimodal support."
    );
  }

  let lastError = null;
  const groqKeys = getGroqKeys();

  for (let i = 0; i < groqKeys.length; i++) {
    const key = groqKeys[i];
    try {
      console.log(`[Copilot Engine] 🚀 Executing request via Groq Engine Key #${i + 1}...`);
      return await generateWithGroq(fullPrompt, key, maxTokens, isJson);
    } catch (err) {
      console.warn(`[Copilot Engine] ⚠️ Groq Key #${i + 1} failed:`, err.message);
      lastError = err;
    }
  }

  const openAiKey = getOpenAiKey();
  if (openAiKey) {
    try {
      console.log(`[Copilot Engine] 🚀 Executing request via OpenAI Engine (fallback)...`);
      return await generateWithOpenAI(fullPrompt, openAiKey, maxTokens, isJson);
    } catch (err) {
      console.warn(`[Copilot Engine] ⚠️ OpenAI fallback failed:`, err.message);
      lastError = err;
    }
  }

  throw new Error(`All Groq API keys/models and the OpenAI fallback failed. Last error: ${lastError?.message}`);
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

export function findMatchingCases(question, rawCases) {
  if (!question || !rawCases || rawCases.length === 0) return [];

  const allCases = rawCases.map(normalizeSheetRecord);

  const qLower = String(question).toLowerCase().trim();
  const qClean = qLower.replace(/[^\w\/\-\s\u0C80-\u0CFF]/g, " ");
  const queryCrimeNumbers = (qLower.match(/(?:cr-?)?\d{1,4}\/\d{4}/gi) || [])
    .map((value) => normalizeCrimeNo(value).toLowerCase());

  const matched = new Set();
  const queryIdTokens = extractIdTokens(qLower);

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

    if (c.CaseMasterID && queryIdTokens.length > 0) {
      const normId = normalizeIdentifier(c.CaseMasterID);
      if (queryIdTokens.some((token) => normalizeIdentifier(token) === normId)) {
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

    if (normCrime && normCrime.length >= 2) {
      if (queryCrimeNumbers.includes(normCrime)) {
        matched.add(c);
        continue;
      }
    }
  }

  if (matched.size > 0) return Array.from(matched);

  const numbersInQuery = qClean.match(/\b\d{1,16}\b/g) || [];
  if (numbersInQuery.length > 0) {
    for (const c of allCases) {
      if (!c) continue;
      const caseNo = String(c.CaseNo || "").toLowerCase().trim();
      const caseMasterId = String(c.CaseMasterID || "").toLowerCase().trim();
      const crimeNo = String(c.CrimeNo || "").toLowerCase().trim();

      for (const num of numbersInQuery) {
        if (num === "2026" || num === "2025" || num === "2024") continue;
        if (caseMasterId === num || caseNo === num || caseNo.endsWith(`/${num}`) || crimeNo === num || crimeNo.endsWith(`/${num}`)) {
          matched.add(c);
        }
      }
    }
    if (matched.size > 0) return Array.from(matched);
  }

  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  const isMostRecentQuery = /\b(most recent|latest|newest|last registered|last filed|last added)\b|ಇತ್ತೀಚಿನ|ಹೊಸ/i.test(qLower);
  if (isMostRecentQuery) {
    const dated = allCases
      .filter((c) => c)
      .map((c) => ({ c, d: parseCaseDate(c.CrimeRegisteredDate || c.IncidentFromDate) }))
      .filter((x) => x.d);

    dated.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
    let sortedCases = dated.map((x) => x.c);

    const filterTerms = qClean
      .split(/\s+/)
      .map(normalizeLocationOrTerm)
      .filter(
        (term) =>
          term.length > 2 &&
          !TIME_AND_QUERY_WORDS.has(term) &&
          !["most", "latest", "newest", "registered", "filed", "added"].includes(term),
      );
    if (filterTerms.length > 0) {
      sortedCases = sortedCases.filter((record) => {
        const rowText = Object.values(record).join(" ").toLowerCase();
        return filterTerms.every((term) => rowText.includes(term));
      });
    }

    const isPlural = /\b(cases|records)\b|ಪ್ರಕರಣಗಳು/i.test(qLower);
    return isPlural ? sortedCases.slice(0, 10) : sortedCases.slice(0, 1);
  }

  const isTodayQuery = qLower.includes("today") || qLower.includes("ಇಂದು");
  const isWeekQuery = qLower.includes("this week") || qLower.includes("past week") || qLower.includes("last week") || qLower.includes("weekly") || qLower.includes("ಈ ವಾರ");
  const isMonthQuery = qLower.includes("this month") || qLower.includes("past month") || qLower.includes("last month") || qLower.includes("monthly") || qLower.includes("ಈ ತಿಂಗಳು");

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
  const looksLikePronounFollowUp =
    /\b(it|its|that|this|those|these|same|above|former|latter)\b/i.test(question) &&
    !/^\s*(who|what|which|where|how|why|when)\b/i.test(question.trim());

  const looksLikeKannadaFollowUp =
    /[ಀ-೿]/.test(question) &&
    /\b(ಇದು|ಅವು)\b/i.test(question) &&
    history.length > 0;

  if ((looksLikePronounFollowUp || looksLikeKannadaFollowUp) && history.length > 0) {
    const userMessages = history
      .filter((m) => m.role === "user")
      .slice(-2)
      .map((m) => m.content)
      .join(" ");
    return `${userMessages} ${question}`;
  }
  return question;
}

export function isCaseRecordQuestion(question) {
  if (looksLikeSpecificIdentifierQuery(question)) return true;

  const trimmed = String(question || "").trim();

  const looksLikeGeneralKnowledge =
    /^(what (?:is|are)|explain|define|how (?:does|do|to)|why)\b/i.test(trimmed);
  if (looksLikeGeneralKnowledge) return false;

  const looksLikeGreetingOrSmallTalk =
    /^(hi|hello|hey|good\s*(morning|afternoon|evening)|thanks?|thank you|ok(ay)?|bye|goodbye)[\s!.,]*$/i.test(
      trimmed,
    );
  if (looksLikeGreetingOrSmallTalk) return false;

  return true;
}

export function isPendingCase(record) {
  const status = String(record?.Status || record?.status || "").trim().toLowerCase();
  if (!status) return false;
  const closedKeywords = ["disposed", "closed", "acquitted", "convicted", "abated", "quashed", "settled"];
  if (closedKeywords.some((k) => status.includes(k))) return false;
  return true;
}

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

export async function getUserChatHistory(userId) {
  if (!userId) return [];
  return chatHistoryStore.get(String(userId)) || [];
}

export async function getSessionById(userId, sessionId) {
  const userSessions = await getUserChatHistory(userId);
  return userSessions.find((s) => s.id === sessionId) || null;
}

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
    const trimmedQuestion = String(question || "").trim();
    const isKannada = language === "kn" || /[\u0C80-\u0CFF]/.test(trimmedQuestion);

    const myStationQuestionRe = /^(which|what|where)\s+is\s+my\s+(police\s+)?station\??$/i;
    const myStationKannadaRe = /^(ನನ್ನ\s+(ಪೊಲೀಸ್\s+)?ಠಾಣೆ\s+ಯಾವುದು\??|ನನ್ನ\s+ಠಾಣೆ\s+ಯಾವುದು\??)/i;

    if (stationId && (myStationQuestionRe.test(trimmedQuestion) || myStationKannadaRe.test(trimmedQuestion))) {
      if (isKannada) {
        let s = stationId.replace(/\bpolice\s+station\b/gi, "").trim();
        const lower = s.toLowerCase();
        const knownPlaces = {
          byappanahalli: "ಬೈಯಪ್ಪನಹಳ್ಳಿ",
          baiyappanahalli: "ಬೈಯಪ್ಪನಹಳ್ಳಿ",
          byatarayanapura: "ಬ್ಯಾಟರಾಯನಪುರ",
          jayanagar: "ಜಯನಗರ",
          indiranagar: "ಇಂದಿರಾನಗರ",
          koramangala: "ಕೋರಮಂಗಲ",
          whitefield: "ವೈಟ್‌ಫೀಲ್ಡ್",
          yelahanka: "ಯಲಹಂಕ",
          upparpet: "ಉಪ್ಪಾರಪೇಟೆ",
          majestic: "ಮೆಜೆಸ್ಟಿಕ್",
          hebbal: "ಹೆಬ್ಬಾಳ",
          marathahalli: "ಮಾರತಹಳ್ಳಿ",
          banashankari: "ಬನಶಂಕರಿ",
          malleswaram: "ಮಲ್ಲೇಶ್ವರಂ",
          malleshwaram: "ಮಲ್ಲೇಶ್ವರಂ",
          rajajinagar: "ರಾಜಾಜಿನಗರ",
          vijayanagar: "ವಿಜಯನಗರ",
          basavanagudi: "ಬಸವನಗುಡಿ",
          shivajinagar: "ಶಿವಾಜಿನಗರ",
          kengeri: "ಕೆಂಗೇರಿ",
          peenya: "ಪೀಣ್ಯ",
          halasuru: "ಹಲಸೂರು",
          ulsoor: "ಹಲಸೂರು",
          mahadevapura: "ಮಹದೇವಪುರ",
          bommanahalli: "ಬೊಮ್ಮನಹಳ್ಳಿ",
        };
        const knName = knownPlaces[lower] || s;
        return `ನಿಮಗೆ ನಿಯೋಜಿಸಲಾದ ಠಾಣೆ ${knName} ಪೊಲೀಸ್ ಠಾಣೆ.`;
      }
      return `Your assigned police station is ${stationId}.`;
    }

    if (String(question || "").toLowerCase().includes("extract fir details into json format")) {
      return JSON.stringify(await generateFirDraft(question));
    }

    const recentHistory = compactConversationHistory(history);
    const searchQuestion = searchQuestionWithHistory(question, recentHistory);
    const asksForCaseRecords = isCaseRecordQuestion(searchQuestion);

    // STRICT MULTI-LINGUAL DIRECTIVE BUILDER
    const languageInstruction = isKannada
      ? `### STRICT LANGUAGE DIRECTIVE:
- TARGET LANGUAGE: KANNADA (ಕನ್ನಡ Script)
- CRITICAL: You MUST respond completely and exclusively in KANNADA script (ಕನ್ನಡ).
- Translate all FIR fields, titles, status terms, and summary facts into natural, fluent Kannada. Do NOT output English paragraphs.`
      : `### STRICT LANGUAGE DIRECTIVE:
- TARGET LANGUAGE: ENGLISH
- CRITICAL: You MUST respond completely and exclusively in ENGLISH.`;

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
      const generalPrompt = `You are the KSPP Copilot, an internal records-lookup tool embedded in the official Karnataka State Police Portal. The person asking is an authenticated, on-duty officer using this tool for legitimate case work. 

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
        getCachedTabRecords("caseMaster", () => readExplicitTabRecords("CaseMaster"), []),
        getCachedTabRecords("accused", () => readExplicitTabRecords("Accused"), []),
        getCachedTabRecords("complainants", () => readExplicitTabRecords("ComplainantDetails"), []),
        getCachedTabRecords("consolidated", () => casesFromGoogle(), { rows: [] }),
      ]);

      const rawSource = consolidatedData.rows && consolidatedData.rows.length > 0
        ? consolidatedData.rows
        : caseMasterRows;

      const allCases = rawSource.map(normalizeSheetRecord);

      const normalizedAccused = (accusedRows || []).map(normalizeSheetRecord);
      const normalizedComplainants = (complainantRows || []).map(normalizeSheetRecord);

      let contextualRows = findMatchingCases(searchQuestion, allCases);
      const matchingCount = contextualRows.length;

      const IMPORTANT_KEYS = [
        "CaseNo", "CrimeNo", "CrimeHead", "CrimeSubHead", "Gravity",
        "PoliceStation", "Status", "Court", "ChargesheetStatus",
        "IncidentFromDate", "CrimeRegisteredDate", "Complainant", "AccusedNames",
        "VictimNames", "Acts", "Sections", "Officer", "EmployeeID", "BriefFacts"
      ];

      function enrichWithLinkedProfiles(cCase) {
        if (!cCase) return {};
        const caseId = String(cCase.CaseMasterID || "").trim();

        const relatedAccusedList = normalizedAccused
          .filter(a => a && String(a.CaseMasterID || "").trim() === caseId)
          .map(a => `${a.AccusedName || "Unknown"}${a.AgeYear ? ` (${a.AgeYear}y)` : ""}`)
          .join(", ");

        const relatedComplainants = normalizedComplainants
          .filter(c => c && String(c.CaseMasterID || "").trim() === caseId)
          .map(c => `${c.ComplainantName || "N/A"}${c.AgeYear ? ` (${c.AgeYear}y)` : ""}`)
          .join(", ");

        return {
          ...cCase,
          AccusedNames: cCase.AccusedNames || relatedAccusedList || "None listed.",
          Complainant: cCase.Complainant || relatedComplainants || "None listed.",
        };
      }

      if (matchingCount === 0) {
        const isIdentifierLookup = looksLikeSpecificIdentifierQuery(searchQuestion);
        if (isIdentifierLookup) {
          answer = isKannada
            ? `"${question}" ಗೆ ಹೊಂದಿಕೆಯಾಗುವ ಯಾವುದೇ ಪ್ರಕರಣ ದಾಖಲೆ ಪೋರ್ಟಲ್ ಡೇಟಾಬೇಸ್‌ನಲ್ಲಿ ಕಂಡುಬಂದಿಲ್ಲ.`
            : `No case record found matching "${question}" in the portal database.`;
        } else {
          answer = isKannada
            ? `ಗೌರವಾನ್ವಿತ ಅಧಿಕಾರಿಗಳೇ, ನಿಮ್ಮ ಅಧಿಕಾರ ವ್ಯಾಪ್ತಿಯಲ್ಲಿ ಈ ಅವಧಿಗೆ/ವಿನಂತಿಗೆ ("${question}") ಸಂಬಂಧಿಸಿದಂತೆ **0** ಪ್ರಕರಣಗಳು ದಾಖಲಾಗಿವೆ (ಒಟ್ಟು ಸಿಸ್ಟಮ್ ಪ್ರಕರಣಗಳು: ${allCases.length}).`
            : `Officer, based on verified database records, there are currently **0** cases registered matching your request ("${question}"). (Total system cases: ${allCases.length}).`;
        }
      } else {
        const singleMatchRecord = matchingCount === 1 ? enrichWithLinkedProfiles(contextualRows[0]) : null;
        const namedFieldMatches = matchingCount === 1 ? matchNamedFieldQuery(searchQuestion) : [];
        const fallbackEntityAnswer =
          matchingCount === 1 && namedFieldMatches.length === 0 && !FULL_DETAIL_INTENT_RE.test(question)
            ? await resolveNamedFieldViaModel(singleMatchRecord, question, isKannada)
            : "";

        if (matchingCount === 1 && namedFieldMatches.length > 0) {
          answer = buildNamedFieldAnswer(singleMatchRecord, namedFieldMatches, isKannada);
        } else if (matchingCount === 1 && fallbackEntityAnswer) {
          answer = fallbackEntityAnswer;
        } else if (matchingCount === 1) {
          const record = singleMatchRecord;
          const matchedRowData = {};
          for (const k of IMPORTANT_KEYS) {
            const v = sanitizeFieldValue(k, record[k]);
            if (!v || v === "N/A" || v === "None listed.") continue;
            matchedRowData[k] = v.replace(/\s+/g, " ").slice(0, 500);
          }

          const dataInstruction = isKannada ? `ನೀವು ಪೋರ್ಟಲ್ ಡೇಟಾಸೆಟ್‌ನಿಂದ ಪಡೆಯಲಾದ ಅಧಿಕೃತ ಪ್ರಕರಣದ ವಿವರಗಳನ್ನು ನೀಡಲಾಗಿದೆ:
${JSON.stringify(matchedRowData)}

ಅಧಿಕಾರಿಯ ಪ್ರಶ್ನೆಗೆ ಸಂಪೂರ್ಣವಾಗಿ ಕನ್ನಡದಲ್ಲಿ (Kannada Script) ಉತ್ತರಿಸಿ.
ರೂಪಣೆ ನಿಯಮಗಳು (ಖಚಿತವಾಗಿ ಅನುಸರಿಸಿ):
- **ಅಪರಾಧ ಸಂಖ್ಯೆ:** ${record.CrimeNo || record.CaseNo || ''}
- **ಅಪರಾಧದ ಮಾದರಿ:** ${record.CrimeHead || ''} (${record.Gravity || ''})
- **ಪೋಲೀಸ್ ಠಾಣೆ:** ${record.PoliceStation || ''}
- **ಪ್ರಸ್ತುತ ಸ್ಥಿತಿ:** ${record.Status || ''}
- **ನೋಂದಾಯಿತ ದಿನಾಂಕ:** ${record.CrimeRegisteredDate || ''}
- **ದೂರುದಾರ:** ${record.Complainant || ''}
- **ಆರೋಪಿ:** ${record.AccusedNames || ''}
- **ಸಂತ್ರಸ್ತರು:** ${record.VictimNames || ''}
- **ತನಿಖಾಧಿಕಾರಿ:** ${record.Officer || ''} (${record.EmployeeID || ''})
- **ಪ್ರಕರಣದ ಸಾರಾಂಶ:** ${record.BriefFacts || ''}

ಮೇಲಿನ ಎಲ್ಲಾ ವಿವರಗಳನ್ನು ಬಳಸಿಕೊಂಡು, ಒಂದು ಸುಂದರವಾದ ಮತ್ತು ಸ್ಪಷ್ಟವಾದ ಕನ್ನಡ ಪರಿಚ್ಛೇದದಲ್ಲಿ ವಿವರಣೆ ನೀಡಿ.`
            : `You are given official case details retrieved directly from the portal dataset:
${JSON.stringify(matchedRowData)}

Answer the officer's question completely using this data. Do NOT output any generic CCTNS or "no access to live police databases" disclaimers. Include only fields relevant to the question.

Formatting rules (follow exactly):
- Write the answer as ONE flowing paragraph of prose.
- Group the facts in this fixed order:
  1. Case/crime identifiers together (Case Number, Crime Number, Crime Head, Crime Sub-Head, Gravity).
  2. Police station, status, court, and chargesheet status together.
  3. All dates together.
  4. All named parties together (Complainant, Accused, Victim).
  5. Legal details together (Acts, Sections).
  6. Officer name and Employee ID together.
  7. End with "Brief Facts:" and its value.`;

          const prompt = `You are the KSPP Copilot, an internal records-lookup tool embedded in the official Karnataka State Police Portal. 

${languageInstruction}

Recent conversation:
${conversationText(recentHistory)}

${attachmentInstruction}

${dataInstruction}

Current officer question: ${JSON.stringify(question)}`;

          answer = await generateWithFallback(prompt, question.length > 300 ? 1100 : 800, false, attachment);
        } else {
          const finalFilteredRows = contextualRows.slice(0, 5).map(enrichWithLinkedProfiles);

          const formattedContext = finalFilteredRows.map((row, i) => {
            const parts = [];
            for (const k of IMPORTANT_KEYS) {
              if (k in row) {
                let v = sanitizeFieldValue(k, row[k]);
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

          const dataInstruction = `${languageInstruction}
Verified database facts:
Total system cases: ${totalSystemCount}. Registered today: ${todayCount}. Full matching count: ${matchingCount}.

Verified records:
${formattedContext}`;

          const prompt = `You are the KSPP Copilot, an internal records-lookup tool embedded in the official Karnataka State Police Portal.

${languageInstruction}

Recent conversation:
${conversationText(recentHistory)}

${attachmentInstruction}

${dataInstruction}

Current officer question: ${JSON.stringify(question)}`;

          const outputBudget = matchingCount > 1 ? 1600 : question.length > 300 ? 1100 : 800;
          answer = await generateWithFallback(prompt, outputBudget, false, attachment);
        }
      }
    }

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

export const findMatchingCasesEnhanced = findMatchingCases;

