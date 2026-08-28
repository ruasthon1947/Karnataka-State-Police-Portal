// src/lib/chatApi.ts
import { collection, deleteDoc, doc, getDocs, orderBy, query, setDoc } from "firebase/firestore";
import { fetchCases } from "./cases";
import { auth, db } from "../firebase";

export type ChatAttachment = {
  name: string;
  mimeType: string;
  content?: string;
  data?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  mapContext?: ChatMapContext;
};

export type ChatMapPoint = {
  id: string;
  label: string;
  station: string;
  latitude: number;
  longitude: number;
};

export type ChatMapContext = {
  destinations: ChatMapPoint[];
  stationOrigin?: ChatMapPoint;
  unavailableReason?: "missing_case_location";
};

export type FirestoreChatSession = {
  id: string;
  title: string;
  timestamp: number;
  messages: ChatMessage[];
};

/**
 * Normalizes crime numbers across formats onto a single canonical "SEQ/YEAR" key:
 * "CR-2026000001" -> "1/2026"  (CaseNo = YEAR + 6-digit zero-padded sequence)
 * "CR-01/2026"    -> "1/2026"  (CrimeNo = SEQ/YEAR)
 * "0001/2026"     -> "1/2026"
 */
function normalizedCrimeNumber(value: string): string {
  if (!value) return "";
  const cleaned = String(value).trim().toUpperCase().replace(/^(CR|FIR)[\s\/\-]*/i, "");

  // Slash/dash format: SEQ/YEAR or YEAR/SEQ (e.g. "01/2026" or "2026/01")
  const slashMatch = cleaned.match(/^(\d{1,4})[\/\-](\d{4})$/);
  if (slashMatch) {
    const [first, second] = [slashMatch[1], slashMatch[2]];
    const year = first.length === 4 ? first : second;
    const seq = first.length === 4 ? second : first;
    return `${Number(seq)}/${year}`;
  }

  // Long compact format: YYYYSSSSSS (e.g. "2026000001" -> "1/2026")
  const longMatch = cleaned.match(/^(\d{4})(\d+)$/);
  if (longMatch) {
    const year = Number(longMatch[1]);
    if (year >= 2015 && year <= 2035) {
      return `${Number(longMatch[2])}/${longMatch[1]}`;
    }
  }

  // Remove leading zeroes from standalone numbers
  return cleaned.replace(/^0+/, "") || "0";
}

/**
 * Helper to fetch authorization headers using the current Firebase ID Token
 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  try {
    const currentUser = auth.currentUser;
    if (currentUser) {
      const token = await currentUser.getIdToken();
      headers["Authorization"] = `Bearer ${token}`;
    }
  } catch {
    // If auth state token is uninitialized, proceed without header
  }

  return headers;
}

async function directIdentityAnswer(
  question: string,
  language: "en" | "kn",
): Promise<string | null> {
  if (!/\bcomplainant\b/i.test(question) && !/\baccused\b/i.test(question)) {
    return null;
  }

  // Support both "CR-2026000001" and "CR-1/2026" patterns
  const requestedNumbers = (
    question.match(/(?:CR-?|FIR\/?\s*)?\d+(?:\/\d{4})?/gi) || []
  )
    .map(normalizedCrimeNumber)
    .filter(Boolean);

  if (requestedNumbers.length !== 1) return null;

  try {
    const data = await fetchCases();
    const matches = (data.cases || []).filter((record) => {
      const targetCrime = normalizedCrimeNumber(record.CrimeNo || record.CaseNo || "");
      return targetCrime === requestedNumbers[0];
    });

    if (matches.length !== 1) return null;

    const record = matches[0];
    const reference = record.CrimeNo || record.CaseNo || record.CaseMasterID;
    const complainant = record.Complainant || (language === "kn" ? "ದಾಖಲಾಗಿಲ್ಲ" : "Not recorded");
    const accused = record.AccusedNames || (language === "kn" ? "ದಾಖಲಾಗಿಲ್ಲ" : "Not recorded");

    return language === "kn"
      ? `📌 **ಪ್ರಕರಣ:** ${reference}\n👤 **ದೂರುದಾರ:** ${complainant}\n🚨 **ಆರೋಪಿ:** ${accused}`
      : `📌 **Case:** ${reference}\n👤 **Complainant:** ${complainant}\n🚨 **Accused:** ${accused}`;
  } catch {
    return null;
  }
}

export async function askCopilot(params: {
  question: string;
  language: "en" | "kn";
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  attachment?: ChatAttachment;
}): Promise<string> {
  const directAnswer = params.attachment
    ? null
    : await directIdentityAnswer(params.question, params.language);
  if (directAnswer) return directAnswer;

  const headers = await getAuthHeaders();

  const res = await fetch("/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({
      question: params.question,
      language: params.language,
      history: params.history,
      attachment: params.attachment,
    }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || !data?.ok) {
    const serverMessage = data?.error || `HTTP ${res.status}`;
    console.error("Chat API error:", serverMessage);
    throw new Error(serverMessage);
  }

  const responseText = data.answer || data.reply || data.response;
  if (typeof responseText !== "string" || !responseText.trim()) {
    throw new Error("The Copilot returned an empty response.");
  }

  return responseText.trim();
}

export type FirDraftContext = {
  allowedValues?: Record<string, string[]>;
  defaults?: Record<string, string>;
};

export async function requestFirDraft(
  complaint: string,
  context?: FirDraftContext,
): Promise<Record<string, string>> {
  const headers = await getAuthHeaders();

  const res = await fetch("/api/fir-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({ complaint, context }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  if (!data.draft || typeof data.draft !== "object" || Array.isArray(data.draft)) {
    throw new Error("The AI did not return a valid FIR draft.");
  }
  return data.draft as Record<string, string>;
}

// -------------------------------------------------------------------
// FIREBASE FIRESTORE SYNC HELPERS
// -------------------------------------------------------------------

/**
 * Fetch all chat sessions for a logged-in user ordered by most recent
 */
export async function fetchUserChatsFromFirebase(userId: string): Promise<FirestoreChatSession[]> {
  if (!userId) return [];
  try {
    const chatsRef = collection(db, "users", userId, "chats");
    const q = query(chatsRef, orderBy("timestamp", "desc"));
    const snapshot = await getDocs(q);
    return snapshot.docs.map((docSnap) => docSnap.data() as FirestoreChatSession);
  } catch (error) {
    console.error("Error fetching chats from Firestore:", error);
    return [];
  }
}

/**
 * Create or overwrite/merge a chat session for a logged-in user
 */
export async function saveChatToFirebase(userId: string, session: FirestoreChatSession): Promise<void> {
  if (!userId || !session.id) return;
  try {
    const sessionRef = doc(db, "users", userId, "chats", session.id);
    await setDoc(sessionRef, session, { merge: true });
  } catch (error) {
    console.error("Error saving chat to Firestore:", error);
  }
}

/**
 * Delete a chat session for a logged-in user
 */
export async function deleteChatFromFirebase(userId: string, sessionId: string): Promise<void> {
  if (!userId || !sessionId) return;
  try {
    const sessionRef = doc(db, "users", userId, "chats", sessionId);
    await deleteDoc(sessionRef);
  } catch (error) {
    console.error("Error deleting chat from Firestore:", error);
  }
}