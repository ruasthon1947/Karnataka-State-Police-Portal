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
    // Serve the last good snapshot rather than an empty result if we have one,
    // so a transient Sheets API hiccup doesn't cause a false "0 cases" answer.
    if (cached) return cached.data;
    return defaultValue;
  }
}

// Call this after any write to the underlying sheet (e.g. a new FIR is filed)
// so the next chat query reflects it immediately instead of waiting out the TTL.
export function invalidateSheetsCache(cacheKey) {
  if (cacheKey) sheetsCache.delete(cacheKey);
  else sheetsCache.clear();
}

// Unified crime number normalization utility.
// Maps every record/query form onto a single canonical "SEQ/YEAR" key so that
// "CR-2026000001" (CaseNo = YYYY + 6-digit sequence), "CR-01/2026", "0001/2026"
// and "1/2026" (CrimeNo = SEQ/YEAR) all collapse to "1/2026".
function normalizeCrimeNoUnified(str) {
  if (!str) return "";
  const cleaned = String(str)
    .trim()
    .toUpperCase()
    .replace(/^(CR|FIR)[\s\/\-]*/i, "");

  // Slash format: SEQ/YEAR or YEAR/SEQ (e.g. "01/2026" -> "1/2026")
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

  // Long compact format: YYYYSSSSSS (e.g. "2026000001" -> "1/2026").
  // CaseNo is generated as `${year}${paddedSeq}` so the first 4 digits are the
  // registration year and the remainder is the zero-padded sequence.
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

// Gemini is intentionally excluded from generateWithFallback (Groq-only by
// explicit instruction). Left commented rather than deleted in case
// multimodal (image/PDF) attachment support needs Gemini back later —
// Groq's models here are text-only.
// const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
//   .split(",")
//   .map((k) => k.trim())
//   .filter(Boolean);
// const FALLBACK_GEMINI_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash-lite"];

const GROQ_KEYS = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

const FALLBACK_GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

// Tertiary fallback, used only after every Groq key/model combination above
// has failed (rate limit, quota, auth, or other error). Requires
// OPENAI_API_KEY in .env. Left undefined-safe so the app still runs (minus
// this last resort) if that key isn't configured.
const OPENAI_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = "gpt-4o-mini";

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

/**
 * Maps varying Google Sheet header keys to uniform standard keys
 */
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

// NOTE: previously this had its own divergent implementation that only handled
// "SEQ/YEAR" style separators and silently fell through to a no-op strip on the
// long "YYYYSSSSSS" CaseNo format (e.g. "2026000001" -> "2026000001" instead of
// "1/2026"). That mismatch was the root cause of CR-2026000001 lookups failing:
// findMatchingCases() normalizes both the query and the stored CrimeNo/CaseNo
// with this function, and "2026000001" was never reduced to the same canonical
// key as "01/2026", so zero rows matched and the chat handler fell back to the
// generic "no data" branch. Delegating to normalizeCrimeNoUnified (which already
// understands both formats) fixes every caller of normalizeCrimeNo in one place.
export function normalizeCrimeNo(str) {
  return normalizeCrimeNoUnified(str);
}

// Normalizes bare/prefixed identifiers (CaseMasterID lookups) onto a single
// digits-only key: strips "CASEMASTER"/"CASE MASTER"/"ID" prefixes, spaces,
// hyphens, and leading zeros. "ID1", "ID-01", "casemaster id 1", and a raw
// sheet value of "1" all collapse to "1".
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

// Extracts candidate ID-style references from free text, e.g. "casemaster id1",
// "ID 01", "case master id-7" -> ["1", "01" -> normalized to "1", ...].
// Returns normalized (leading-zero-stripped) digit strings for direct
// comparison against normalizeIdentifier(record.CaseMasterID).
function extractIdTokens(text) {
  const matches = String(text || "").matchAll(/\b(?:case\s*master\s*)?id[\s\-]*0*(\d+)\b/gi);
  return Array.from(matches, (m) => m[1]);
}

// True when the question is a targeted identifier lookup (CR-.../FIR.../
// CaseNo/CrimeNo/CaseMasterID) rather than a general keyword or date-range
// question. Used to pick the right "no match" response.
function looksLikeSpecificIdentifierQuery(text) {
  const t = String(text || "");
  if (/\b(?:cr|fir)[\s\-\/]*\d+/i.test(t)) return true; // CR-2026000001, FIR/12
  if (/\b\d{1,4}[\/\-]\d{4}\b/.test(t)) return true; // SEQ/YEAR e.g. 1/2026
  if (/\b\d{6,}\b/.test(t)) return true; // long compact CaseNo e.g. 2026000001
  if (/\b(?:case\s*master\s*)?id[\s\-]*0*\d+\b/i.test(t)) return true; // ID1, casemaster id 7
  return false;
}

// Detects values Google Sheets silently mangled into scientific notation
// (e.g. "1.0001E+17"). This happens when a long digit-only crime/case number
// is typed into a cell that isn't formatted as Plain Text: Sheets treats it
// as a Number, and once it exceeds ~15 significant digits the FORMATTED_VALUE
// the API returns is literally the scientific-notation display string — the
// original digits are gone, not just displayed oddly. This is a source-data
// problem (fix the sheet cell's format + re-enter the value as text), not
// something the app can safely reconstruct. Rather than let a mangled value
// reach the model and get presented to an officer as a real crime/case
// number, flag it so the answer says "verify at source" instead.
const SCIENTIFIC_NOTATION_RE = /^-?\d+(\.\d+)?e[+-]?\d+$/i;
function sanitizeFieldValue(key, value) {
  const v = String(value ?? "").trim();
  if (SCIENTIFIC_NOTATION_RE.test(v)) {
    console.warn(
      `[Copilot Engine] '${key}' looks corrupted by Sheets auto-number-formatting (got "${v}"). ` +
      `Fix: set that column's format to Plain Text in the Google Sheet and re-enter the value as text.`
    );
    return "⚠ data formatting issue in source sheet — verify against the original record";
  }
  return v;
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

// Canned safety refusals come back as a normal, non-empty, non-truncated
// response — nothing about the HTTP status or finish_reason distinguishes
// them from a real answer. Left unchecked, a refusal like "I'm sorry, but I
// can't help with that" gets returned to the officer as if it were the
// actual case data. Treating a detected refusal as a failure lets the
// existing model/key rotation route around it instead.
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

// Tertiary fallback (only reached once both Groq keys above have failed).
// Mirrors generateWithGroq's request shape, JSON-mode handling, refusal
// check, and truncation/continuation logic exactly, so callers see identical
// behavior regardless of which engine ultimately answered.
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
  // Groq-only by explicit instruction — Gemini is no longer in this request
  // path. Tradeoff worth knowing: Groq's gpt-oss models here are text-only
  // (no inlineData / image support), so a binary attachment (a photo or PDF
  // sent as attachment.data) can no longer be analyzed — only Gemini could
  // do that. Text attachments (txt/csv/json/md) are unaffected, since those
  // were always embedded as plain text in the prompt, not sent as binary
  // data. If image/PDF analysis matters, that capability needs Gemini back
  // in the chain specifically for attachment.data requests.
  if (attachment?.data) {
    throw new Error(
      "This request includes an image/PDF attachment, which needs multimodal support. " +
      "Groq's models here are text-only, so binary attachment analysis isn't available " +
      "while Gemini is excluded from the fallback chain."
    );
  }

  let lastError = null;

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

  // Tertiary fallback: every Groq key/model above failed (rate limit, quota,
  // auth, or otherwise) — try OpenAI before giving up on the request.
  if (OPENAI_KEY) {
    try {
      console.log(`[Copilot Engine] 🚀 Executing request via OpenAI Engine (fallback)...`);
      return await generateWithOpenAI(fullPrompt, OPENAI_KEY, maxTokens, isJson);
    } catch (err) {
      console.warn(`[Copilot Engine] ⚠️ OpenAI fallback failed:`, err.message);
      lastError = err;
    }
  } else {
    console.warn("[Copilot Engine] ⚠️ OpenAI fallback skipped: OPENAI_API_KEY not configured.");
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

  // Always normalize case records first
  const allCases = rawCases.map(normalizeSheetRecord);

  const qLower = String(question).toLowerCase().trim();
  const qClean = qLower.replace(/[^\w\/\-\s]/g, " ");
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

    // Explicit "ID"/"casemaster id" reference (handles prefix/padding
    // mismatches like "ID1" vs a stored "01" that substring matching misses).
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

  // "Most recent case" / "latest case" queries have no literal keyword to
  // match against sheet data — the word "recent"/"latest" never appears
  // inside an actual case record — so the generic text-matching below
  // always returned zero results for these, even with 1000+ real cases in
  // the sheet. This explicitly sorts by CrimeRegisteredDate (falling back
  // to IncidentFromDate) and returns the newest record(s) instead.
  const isMostRecentQuery = /\b(most recent|latest|newest|last registered|last filed|last added)\b/i.test(qLower);
  if (isMostRecentQuery) {
    const dated = allCases
      .filter((c) => c)
      .map((c) => ({ c, d: parseCaseDate(c.CrimeRegisteredDate || c.IncidentFromDate) }))
      .filter((x) => x.d);

    dated.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
    let sortedCases = dated.map((x) => x.c);

    // Allow combining with a location/category filter, e.g. "most recent
    // case in Whitefield" — exclude the recency keywords themselves so
    // they aren't treated as filter terms.
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

    // Plural phrasing ("most recent cases", "latest 5 cases") returns a
    // short list; singular phrasing ("the most recent case") returns just
    // the single newest record.
    const isPlural = /\b(cases|records)\b/i.test(qLower);
    return isPlural ? sortedCases.slice(0, 10) : sortedCases.slice(0, 1);
  }

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
  // Default to TRUE: search the sheet unless the question is clearly
  // general-knowledge or a greeting/small-talk. findMatchingCases() has its
  // own robust token-based fallback, so an over-inclusive "yes, search" here
  // just costs a lookup that returns "no match" — whereas an over-restrictive
  // keyword gate silently skips the sheet and returns a fake "no access"
  // disclaimer even when real matching data exists.
  //
  // Previously this function ended on a narrow keyword regex
  // (fir|crime|case no|complainant|...|police station|...) as its real
  // decision point. That regex is why queries kept slipping through:
  //   - "cases in indiranagar station": plural "cases" doesn't match
  //     because the regex's trailing \b fails right after "case" when
  //     followed immediately by "s" (word-char to word-char = no boundary).
  //   - "station" alone was never in the list; only the literal phrase
  //     "police station" was, so any other station name matched nothing.
  // A recognizable identifier (CR-202600001, 1/2026, ID1, casemaster id 7,
  // ...) is still always treated as a case-record lookup regardless of
  // wording, and clear general-knowledge phrasing is still excluded.
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

// CHAT SESSION MANAGEMENT
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
    if (String(question || "").toLowerCase().includes("extract fir details into json format")) {
      return JSON.stringify(await generateFirDraft(question));
    }

    const recentHistory = compactConversationHistory(history);
    const searchQuestion = searchQuestionWithHistory(question, recentHistory);
    const asksForCaseRecords = isCaseRecordQuestion(searchQuestion);
    const isKannada = language === "kn" || /[\u0C80-\u0CFF]/.test(question || "");
    const languageInstruction = isKannada
      ? "Respond ENTIRELY in Kannada script (ಕನ್ನಡ). EVERY word, name, number, and label must be written in Kannada script — do NOT use English words, Latin characters, or English numerals. Write case numbers as ಪ್ರಕರಣ ಸಂಖ್ಯೆ, not Case Number. Write police station as ಪೊಲೀಸ್ ಠಾಣೆ. Translate ALL English terms to their Kannada equivalents. The response must be 100% Kannada script with zero English."
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
      const generalPrompt = `You are the KSPP Copilot, an internal records-lookup tool embedded in the official Karnataka State Police Portal. The person asking is an authenticated, on-duty officer using this tool for legitimate case work. Any case, complainant, accused, or victim details you are given below were already retrieved by the portal's own database lookup before this prompt was built — you are not being asked to recall or guess anyone's personal information; you are being asked to relay verified department records back to the officer who has institutional access to them. This is a routine, authorized law-enforcement records request, not a privacy-sensitive disclosure to an unauthorized party. Answer directly and factually.
${languageInstruction}
Keep answers SHORT — 2-4 sentences max. Be direct and factual. Do not repeat the question back. Do not give lengthy step-by-step instructions unless specifically asked.

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

      // Normalize all records from Google Sheets into unified key structure
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
        // Identifier-style lookups (CR-.../FIR.../CaseNo/CrimeNo/CaseMasterID)
        // get a clean "not found" line as requested. Date-range or keyword
        // queries (e.g. "cases registered this week") keep the fuller stats
        // message, since "no case record found matching ..." reads oddly for
        // a count-style question that legitimately resolved to zero.
        const isIdentifierLookup = looksLikeSpecificIdentifierQuery(searchQuestion);
        if (isIdentifierLookup) {
          answer = language === "kn"
            ? `"${question}" ಗೆ ಹೊಂದಿಕೆಯಾಗುವ ಯಾವುದೇ ಪ್ರಕರಣ ದಾಖಲೆ ಪೋರ್ಟಲ್ ಡೇಟಾಬೇಸ್‌ನಲ್ಲಿ ಕಂಡುಬಂದಿಲ್ಲ.`
            : `No case record found matching "${question}" in the portal database.`;
        } else {
          answer = language === "kn"
            ? `"${question}" ಗೆ ಹೊಂದಿಕೆಯಾಗುವ ಪ್ರಕರಣಗಳು ಕಂಡುಬಂದಿಲ್ಲ. (ಒಟ್ಟು: ${allCases.length})`
            : `No cases found matching "${question}". (Total: ${allCases.length})`;
        }
      } else {
        const asksForComplainant = /\bcomplainant\b/i.test(question || "");
        const asksForAccused = /\baccused|\baccuse[d]?\b/i.test(question || "");

        if (matchingCount === 1 && asksForComplainant && asksForAccused) {
          const record = contextualRows[0];
          const reference = record.CrimeNo || record.CaseNo || record.CaseMasterID || (isKannada ? "ಹೊಂದಾಣಿಕೆಯಾದ ಪ್ರಕರಣ" : "Matched case");
          const complainant = record.Complainant || (isKannada ? "ದಾಖಲಾಗಿಲ್ಲ" : "Not recorded");
          const accused = record.AccusedNames || (isKannada ? "ದಾಖಲಾಗಿಲ್ಲ" : "Not recorded");
          answer = isKannada
            ? `📌 **ಪ್ರಕರಣ:** ${reference}\n👤 **ದೂರುದಾರ:** ${complainant}\n🚨 **ಆರೋಪಿ:** ${accused}`
            : `📌 **Case:** ${reference}\n👤 **Complainant:** ${complainant}\n🚨 **Accused:** ${accused}`;
        } else if (matchingCount === 1) {
          // Single unambiguous match: inject ONLY this row, as compact JSON,
          // so the model gets the smallest possible authoritative context
          // and has no room to fall back on a generic CCTNS disclaimer.
          const record = enrichWithLinkedProfiles(contextualRows[0]);
          const matchedRowData = {};
          for (const k of IMPORTANT_KEYS) {
            const v = sanitizeFieldValue(k, record[k]);
            if (!v || v === "N/A" || v === "None listed.") continue;
            matchedRowData[k] = v.replace(/\s+/g, " ").slice(0, 500);
          }

          const dataInstruction = `You are given official case details retrieved directly from the portal dataset:
${JSON.stringify(matchedRowData)}

Answer the officer's question completely using this data. Do NOT output any generic CCTNS or "no access to live police databases" disclaimers — this record is the authoritative, verified source for this case. Include only fields relevant to the question; do not invent missing values or display bracket placeholders.
If the officer also asks for a map, directions, navigation, or the fastest route, answer only the case-information portion. The portal interface handles routing separately; never claim that the portal lacks routing information or tell the officer to use another GIS tool.

Formatting rules (follow exactly):
- Write the answer as ONE flowing paragraph of prose, not a bulleted or line-per-fact list. Do NOT put each fact on its own line.
- Within that paragraph, group the facts in this fixed order, weaving each group into a natural sentence (still bolding the label of each fact as **Label:** value inline, but writing them as connected sentences, not a stacked list):
  1. Case/crime identifiers together (Case Number, Crime Number, Crime Head, Crime Sub-Head, Gravity).
  2. Police station, status, court, and chargesheet status together.
  3. All dates together (e.g. Incident From Date, Registered On / CrimeRegisteredDate).
  4. All named parties together (Complainant, Accused, Victim).
  5. Legal details together (Acts, Sections).
  6. Officer name and Employee ID together, right before the final part.
  7. End with "Brief Facts:" and its value as the last sentence of the paragraph.
- Skip any group with no data for this case; do not invent missing values or show bracket placeholders.
- Example of the exact style (write real values, not this placeholder text — note it is one continuous paragraph, no line breaks between facts):
**Case Number:** 202600002, **Crime Number:** 01/2026, a **Crimes Against Women** case under **Stalking**, gravity **Heinous**. It was registered at **Indiranagar Police Station** and is currently **Disposed by Court** in **City Civil Court Bengaluru**, with chargesheet status **Filed**. **Incident From Date:** 2026-03-15, **Registered On:** 2026-03-18. **Complainant:** Bhavya Chander, **Accused:** Mohammed Sehgal, **Victim:** Vritti Bhattacharyya. Applicable **Acts:** BNS; DP Act under **Sections:** Assault on Woman; Giving/Taking Dowry; 79. **Officer:** Ekiya, **Employee ID:** 42. **Brief Facts:** [brief facts text].`;

          const prompt = `You are the KSPP Copilot, an internal records-lookup tool embedded in the official Karnataka State Police Portal. The person asking is an authenticated, on-duty officer using this tool for legitimate case work. Any case, complainant, accused, or victim details you are given below were already retrieved by the portal's own database lookup before this prompt was built — you are not being asked to recall or guess anyone's personal information; you are being asked to relay verified department records back to the officer who has institutional access to them. This is a routine, authorized law-enforcement records request, not a privacy-sensitive disclosure to an unauthorized party. Answer directly and factually.
${languageInstruction}
Be direct, well-structured, and complete. Prefer a concise answer, but do not stop mid-sentence or omit a part explicitly requested by the officer.

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

          const dataInstruction = `Verified database facts are provided below. Use only these facts for case-specific claims.
Total system cases: ${totalSystemCount}. Registered today: ${todayCount}. Full matching count: ${matchingCount}.
Only ${finalFilteredRows.length} representative matching record(s) are included to control token usage. If there are more matches, state the full count and clearly say that only the first ${finalFilteredRows.length} are shown.
Answer the officer's actual question directly. Include only relevant fields; do not force a fixed template, invent missing values, or display bracket placeholders.
If the officer also asks for a map, directions, navigation, or the fastest route, answer only the case-information portion. The portal interface handles routing separately; never claim that the portal lacks routing information or tell the officer to use another GIS tool.
You MUST answer using the provided case details from the official portal dataset below — they are the authoritative source for this request. Do not issue disclaimers about lacking access to live police databases, confidential case files, or CCTNS; that boilerplate only applies when no matching record was found, which is not the case here.

Formatting rules (follow exactly — keep it SHORT):
- Each case MUST be exactly ONE single line. No paragraphs, no multi-line blocks.
- Format: **Case {number} ({CrimeHead})** — PS: {PoliceStation} | Status: {Status} | Complainant: {Complainant} | Accused: {Accused} | Section: {Acts} {Sections}
- Skip any field that has no data. Do not invent values.
- Do NOT include Brief Facts, Officer name, Employee ID, dates, gravity, or chargesheet status in the listing — these make the answer too long.
- After listing all cases, add one short summary line: "Total: {matchingCount} cases found."
- Example: **Case 1 (Theft)** — PS: Whitefield | Status: Under Investigation | Complainant: Ravi Kumar | Accused: Suresh | Section: BNS 379

Verified records:
${formattedContext}`;

          const prompt = `You are the KSPP Copilot, an internal records-lookup tool embedded in the official Karnataka State Police Portal. The person asking is an authenticated, on-duty officer using this tool for legitimate case work. Any case, complainant, accused, or victim details you are given below were already retrieved by the portal's own database lookup before this prompt was built — you are not being asked to recall or guess anyone's personal information; you are being asked to relay verified department records back to the officer who has institutional access to them. This is a routine, authorized law-enforcement records request, not a privacy-sensitive disclosure to an unauthorized party. Answer directly and factually.
${languageInstruction}
Be direct, well-structured, and complete. Prefer a concise answer, but do not stop mid-sentence or omit a part explicitly requested by the officer.

Recent conversation:
${conversationText(recentHistory)}

${attachmentInstruction}

${dataInstruction}

Current officer question: ${JSON.stringify(question)}`;

          const outputBudget = matchingCount > 1 ? 600 : question.length > 300 ? 800 : 500;
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

// findMatchingCasesEnhanced used to be a separate, hand-maintained copy of the
// matching logic above (with its own call to normalizeCrimeNoUnified). Because
// handleChatQuery() actually calls findMatchingCases(), not this function, the two
// implementations silently drifted apart and only findMatchingCasesEnhanced ever
// got the long-CaseNo-format fix. It is now a thin alias so there is exactly one
// matching implementation to maintain and both names stay in sync.
export const findMatchingCasesEnhanced = findMatchingCases;

