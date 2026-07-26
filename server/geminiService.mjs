import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { GoogleGenAI } from "@google/genai";
import { readExplicitTabRecords } from "./sheetsStore.mjs";
import { casesFromGoogle } from "./googleSheets.mjs";

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
    .replace(/^CR-?/i, ""); // Strip leading "CR-" or "CR"

  const parts = cleaned.split("/");
  if (parts.length === 2) {
    const seq = parts[0].replace(/^0+/, ""); // Strip leading zeros from sequence
    return `${seq}/${parts[1]}`;
  }
  return cleaned;
}

async function generateWithGroq(prompt, apiKey, maxTokens = 350, isJson = false) {
  for (const model of FALLBACK_GROQ_MODELS) {
    try {
      console.log(`[Copilot Engine] Calling Groq model '${model}'...`);
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.0,
          max_tokens: maxTokens,
          ...(isJson ? { response_format: { type: "json_object" } } : {})
        })
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (text) return text.trim();
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

async function generateWithFallback(fullPrompt, maxTokens = 350, isJson = false) {
  let lastError = null;

  // 1. Try Gemini API keys
  for (const modelName of FALLBACK_GEMINI_MODELS) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
      const key = GEMINI_KEYS[i];
      try {
        const ai = new GoogleGenAI({ apiKey: key });
        const config = { maxOutputTokens: maxTokens };
        if (isJson) {
          config.responseMimeType = "application/json";
        }

        const response = await ai.models.generateContent(
          {
            model: modelName,
            contents: fullPrompt,
            config: config
          },
          { timeout: 30000 }
        );
        return response.text.trim();
      } catch (err) {
        const errorMsg = err.message || String(err);
        console.warn(`[Copilot Engine] ⚠️ Gemini Key #${i + 1} failed on '${modelName}' (${err.status || 'Quota/404'}). Retrying...`);
        lastError = err;
      }
    }
  }

  // 2. Try Groq API keys as fallback engine
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

  // 1. Direct CaseNo, CaseMasterID, CrimeNo exact matching
  for (const c of allCases) {
    if (!c) continue;
    const caseNo = String(c.CaseNo || "").toLowerCase().trim();
    const crimeNo = String(c.CrimeNo || "").toLowerCase().trim();
    const caseMasterId = String(c.CaseMasterID || "").toLowerCase().trim();
    const normCrime = normalizeCrimeNo(c.CrimeNo).toLowerCase();

    // Check CaseNo
    if (caseNo && (qLower.includes(caseNo) || qClean.includes(caseNo))) {
      matched.add(c);
      continue;
    }

    // Check CaseNo without FIR/ prefix (e.g. 2026/1042)
    if (caseNo.startsWith("fir/")) {
      const bareNo = caseNo.replace(/^fir\//i, "");
      if (bareNo && (qLower.includes(bareNo) || qClean.includes(bareNo))) {
        matched.add(c);
        continue;
      }
    }

    // Check CaseMasterID as full standalone word
    if (caseMasterId) {
      const re = new RegExp(`\\b${caseMasterId}\\b`, "i");
      if (re.test(qClean)) {
        matched.add(c);
        continue;
      }
    }

    // Check CrimeNo
    if (crimeNo && (qLower.includes(crimeNo) || qClean.includes(crimeNo))) {
      matched.add(c);
      continue;
    }

    // Check normalized CrimeNo (e.g. CR-6114/2026 -> 6114/2026)
    if (normCrime && normCrime.length >= 4) {
      // Compare complete crime-number tokens. A substring comparison makes
      // 1/2026 incorrectly match a query for 11/2026.
      if (queryCrimeNumbers.includes(normCrime)) {
        matched.add(c);
        continue;
      }
    }
  }

  if (matched.size > 0) return Array.from(matched);

  // 2. Token numeric matching for whole numeric tokens in query
  const numbersInQuery = qClean.match(/\b\d{3,16}\b/g) || [];
  if (numbersInQuery.length > 0) {
    for (const c of allCases) {
      if (!c) continue;
      const caseNo = String(c.CaseNo || "").toLowerCase().trim();
      const caseMasterId = String(c.CaseMasterID || "").toLowerCase().trim();
      const crimeNo = String(c.CrimeNo || "").toLowerCase().trim();

      for (const num of numbersInQuery) {
        if (num === "2026") continue; // skip common current year standalone token
        if (caseMasterId === num || caseNo === num || caseNo.endsWith(`/${num}`) || crimeNo === num || crimeNo.endsWith(`/${num}`)) {
          matched.add(c);
        }
      }
    }
    if (matched.size > 0) return Array.from(matched);
  }

  // 3. Date / Timeframe query matching ("this week", "today", "this month")
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

    for (const c of allCases) {
      if (!c) continue;
      const parsedDate = parseCaseDate(c.CrimeRegisteredDate || c.IncidentFromDate);
      if (parsedDate && parsedDate >= startDateStr && parsedDate <= todayStr) {
        matched.add(c);
      }
    }
    return Array.from(matched);
  }

  // 4. Multi-term Category / Station search matching (e.g. kidnapping in whitefield)
  const tokens = qClean.split(/\s+/).map(normalizeLocationOrTerm).filter(t => t.length > 2 && !STOP_WORDS.has(t));
  if (tokens.length > 0) {
    // Try matching ALL search tokens in the row
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

    // Fallback: match ANY significant search token
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

/**
 * Dedicated FIR Auto-Fill Exporter for NewFIR
 */
export async function generateFirDraft(unstructuredText) {
  const prompt = `
Extract structured FIR details from the following police incident description. Return one complete, valid JSON object only: no markdown, no comments, and no text before or after the JSON. Escape all quotation marks and line breaks inside string values.

JSON Keys Required:
{
  "CaseMasterID": "string or empty",
  "CaseNo": "string or empty",
  "CrimeNo": "string or empty",
  "CrimeRegisteredDate": "YYYY-MM-DD or empty",
  "CrimeHead": "string",
  "CrimeSubHead": "string",
  "PoliceStation": "string",
  "PoliceStationType": "string or empty",
  "District": "Bangalore Urban",
  "Court": "string",
  "EmployeeID": "string or empty",
  "Officer": "string",
  "OfficerRank": "string or empty",
  "OfficerDesignation": "string or empty",
  "CaseCategory": "FIR",
  "Gravity": "Non-Heinous",
  "Status": "Under Investigation",
  "Acts": "string",
  "Sections": "string",
  "Complainant": "string",
  "VictimNames": "string",
  "AccusedNames": "string",
  "IncidentFromDate": "YYYY-MM-DD HH:MM:SS or empty",
  "IncidentToDate": "YYYY-MM-DD HH:MM:SS or empty",
  "InfoReceivedPSDate": "YYYY-MM-DD HH:MM:SS or empty",
  "Latitude": "string or empty",
  "Longitude": "string or empty",
  "BriefFacts": "detailed brief facts",
  "ArrestCount": "number as string",
  "ChargesheetCount": "number as string",
  "ChargesheetStatus": "Pending or Submitted"
}

Incident facts:
"""
${unstructuredText}
"""
`;

  const rawDraft = await generateWithFallback(prompt, 1500, true);
  try {
    return parseFirDraftJson(rawDraft);
  } catch {
    // Some providers occasionally emit an otherwise correct object with an
    // unescaped quote in a narrative field.  Repair it before returning any
    // draft to the browser, rather than making the officer handle AI syntax.
    const repairedDraft = await generateWithFallback(
      `Return a valid JSON object only. Repair the following FIR draft without changing its facts. Escape all quotes and line breaks inside string values.\n\n${rawDraft}`,
      1500,
      true,
    );
    return parseFirDraftJson(repairedDraft);
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

export async function handleChatQuery({
  question,
  role,
  stationId,
  employeeId,
  language,
}) {
  try {
    // Check if the query is an FIR draft auto-fill request
    if (String(question || "").toLowerCase().includes("extract fir details into json format")) {
      return JSON.stringify(await generateFirDraft(question));
    }

    // 1. Fetch tables simultaneously
    const [caseMasterRows, accusedRows, complainantRows, consolidatedData] = await Promise.all([
      readExplicitTabRecords("CaseMaster").catch(() => []),
      readExplicitTabRecords("Accused").catch(() => []),
      readExplicitTabRecords("ComplainantDetails").catch(() => []),
      casesFromGoogle().catch(() => ({ rows: [] }))
    ]);

    // Use consolidated rows as primary case records since it merges CaseMaster and full details
    const sourceCases = consolidatedData.rows && consolidatedData.rows.length > 0
      ? consolidatedData.rows
      : caseMasterRows;
    // The assistant powers the same shared statewide case lookup as the
    // dashboard.  Do not reduce its source to the signed-in officer's small
    // assignment list, otherwise valid FIR queries incorrectly return zero.
    const allCases = sourceCases;

    let contextualRows = findMatchingCases(question, allCases);

    // Fallback Context Guard: Only if query is generic and not date/FIR specific
    const isTimeOrSpecificSearch = /fir|cr-|\d{3,}|today|week|month|year|recent|last/i.test(question || "");
    if (contextualRows.length === 0 && !isTimeOrSpecificSearch && allCases.length > 0) {
      contextualRows = allCases.slice(0, 3);
    }

    // Ultra-lean context cap to keep prompt tokens in the 100s range (max 3 cases)
    contextualRows = contextualRows.slice(0, 3);

    if (contextualRows.length === 0) {
      return language === "kn"
        ? `ಗೌರವಾನ್ವಿತ ಅಧಿಕಾರಿಗಳೇ, ನಿಮ್ಮ ಅಧಿಕಾರ ವ್ಯಾಪ್ತಿಯಲ್ಲಿ ಈ ಅವಧಿಗೆ/ವಿನಂತಿಗೆ ("${question}") ಸಂಬಂಧಿಸಿದಂತೆ **0** ಪ್ರಕರಣಗಳು ದಾಖಲಾಗಿವೆ (ಒಟ್ಟು ಸಿಸ್ಟಮ್ ಪ್ರಕರಣಗಳು: ${allCases.length}).`
        : `Officer, based on verified database records, there are currently **0** cases registered matching your request ("${question}"). (Total system cases: ${allCases.length}).`;
    }

    // Factual identity lookups should be answered from the matched row, not
    // generated by a model. This preserves the exact complainant/accused
    // names and avoids partial or truncated chat responses.
    const asksForComplainant = /\bcomplainant\b/i.test(question || "");
    const asksForAccused = /\baccused|\baccuse[d]?\b/i.test(question || "");
    if (contextualRows.length === 1 && asksForComplainant && asksForAccused) {
      const record = contextualRows[0];
      const reference = record.CrimeNo || record.CaseNo || record.CaseMasterID || "Matched case";
      const complainant = record.Complainant || "Not recorded";
      const accused = record.AccusedNames || "Not recorded";
      return `📌 **Case:** ${reference}\n👤 **Complainant:** ${complainant}\n🚨 **Accused:** ${accused}`;
    }

    // 2. Inject relational details onto the case blocks safely (concise 1-liners)
    contextualRows = contextualRows.map(cCase => {
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

    if (finalFilteredRows.length === 0) {
      return language === "kn"
        ? "ಗೌರವಾನ್ವಿತ ಅಧಿಕಾರಿಗಳೇ, ನಿಮ್ಮ ಅಧಿಕಾರ ವ್ಯಾಪ್ತಿಯಲ್ಲಿ ಈ ಹೆಸರಿಗೆ ಸಂಬಂಧಿಸಿದ ಯಾವುದೇ ದಾಖಲೆಗಳು ಕಂಡುಬಂದಿಲ್ಲ."
        : "Respectful greetings Officer. Based on the verified database records currently available, there are no records found matching the requested query within your authorization scope.";
    }

    // 3. Build ultra-lean prompt payload for Gemini / Groq (< 300 prompt tokens total)
    const isKannada = language === "kn" || /[\u0C80-\u0CFF]/.test(question || "");

    const IMPORTANT_KEYS = [
      "CaseNo", "CrimeNo", "CrimeHead", "CrimeSubHead", "Gravity",
      "PoliceStation", "Status", "Court", "ChargesheetStatus",
      "IncidentFromDate", "CrimeRegisteredDate", "Complainant", "AccusedNames"
    ];

    const formattedContext = finalFilteredRows.map((row, i) => {
      const parts = [];
      const usedKeys = new Set();

      for (const k of IMPORTANT_KEYS) {
        if (k in row) {
          let v = String(row[k] ?? "").trim();
          if (!v || v === "N/A" || v === "None listed.") continue;
          v = v.replace(/\s+/g, " ");
          parts.push(`${k}: ${v}`);
          usedKeys.add(k);
        }
      }

      return `[Case ${i + 1}] ${parts.join(" | ")}`;
    }).join("\n");

    const totalSystemCount = allCases.length;
    const todayStr = new Date().toISOString().split("T")[0];
    const todayCount = allCases.filter(r => String(r.CrimeRegisteredDate || "").startsWith(todayStr)).length;

    const prompt = isKannada ? `
Official Karnataka Police Copilot AI. Read & respond EXCLUSIVELY in Kannada (ಕನ್ನಡ).
DB Stats: Total: ${totalSystemCount}, Today: ${todayCount}, Matching query: ${finalFilteredRows.length}.
If user asked for a count/summary, state the matching count (${finalFilteredRows.length}) clearly first.

Response Layout:
📌 **ಪ್ರಕರಣದ ಸಂಖ್ಯೆ:** [CaseNo] (ಅಪರಾಧ ಸಂಖ್ಯೆ: [CrimeNo])
🏷️ **ಅಪರಾಧದ ಪ್ರಕಾರ:** [CrimeHead] - [CrimeSubHead]
🏛️ **ಪೊಲೀಸ್ ಠಾಣೆ ಮತ್ತು ತನಿಖಾಧಿಕಾರಿ:** [PoliceStation] | [Officer] (ID: [EmployeeID])
👤 **ದೂರುದಾರರು:** [Complainant] | 🚨 **ಆರೋಪಿಗಳು:** [AccusedNames]
📊 **ಪ್ರಸ್ತುತ ಸ್ಥಿತಿ:** [Status] | ನ್ಯಾಯಾಲಯ: [Court]
📅 **ಸಮಯಾವಧಿ:** ನೋಂದಣಿ: [CrimeRegisteredDate]
📝 **ಸಂಕ್ಷಿಪ್ತ ಸಾರಾಂಶ:** [1-2 ವಾಕ್ಯಗಳಲ್ಲಿ ಸಾರಾಂಶ]

Use only the verified values in Context. For direct questions about a complainant or accused, answer those fields plainly and do not add unrelated sections.

Context:
${formattedContext}

User Query: "${question}"
` : `
Official Karnataka Police Copilot AI. Respond EXCLUSIVELY in English.
DB Stats: Total: ${totalSystemCount}, Today: ${todayCount}, Matching query: ${finalFilteredRows.length}.
If user asked a count question, state the matching count (${finalFilteredRows.length}) clearly in your summary statement first.

Response Layout:
📌 **Case Number:** [CaseNo] (Crime No: [CrimeNo])
🏷️ **Offence:** [CrimeHead] - [CrimeSubHead]
🏛️ **Station & IO:** [PoliceStation] | [Officer] (ID: [EmployeeID])
👤 **Complainant:** [Complainant] | 🚨 **Accused:** [AccusedNames]
📊 **Status:** [Status] | Court: [Court]
📅 **Timeline:** Registered: [CrimeRegisteredDate]
📝 **Summary:** [1-2 sentences concise summary]

Use only the verified values in Context. For direct questions about a complainant or accused, answer those fields plainly and do not add unrelated sections.

Context:
${formattedContext}

User Query: "${question}"
`;

    return await generateWithFallback(prompt, 350, false);
  } catch (err) {
    console.error("[Copilot Engine] Generation failed.", err);
    throw new Error("Copilot could not complete this request.");
  }
}
