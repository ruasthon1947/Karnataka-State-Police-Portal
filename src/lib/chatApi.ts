// src/lib/chatApi.ts
import { collection, deleteDoc, doc, getDocs, orderBy, query, setDoc } from "firebase/firestore";
import { fetchCases } from "./cases";
import { db } from "../firebase";

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
};

export type FirestoreChatSession = {
  id: string;
  title: string;
  timestamp: number;
  messages: ChatMessage[];
};

function normalizedCrimeNumber(value: string): string {
  const cleaned = String(value || "").trim().toUpperCase().replace(/^CR-?/i, "");
  const match = cleaned.match(/^(\d{1,4})\/(\d{4})$/);
  return match ? `${Number(match[1])}/${match[2]}` : cleaned;
}

async function directIdentityAnswer(question: string): Promise<string | null> {
  if (!/\bcomplainant\b/i.test(question) || !/\baccused\b/i.test(question)) {
    return null;
  }
  const requestedNumbers = (question.match(/(?:CR-?)?\d{1,4}\/\d{4}/gi) || [])
    .map(normalizedCrimeNumber);
  if (requestedNumbers.length !== 1) return null;

  try {
    const data = await fetchCases();
    const matches = (data.cases || []).filter(
      (record) => normalizedCrimeNumber(record.CrimeNo || "") === requestedNumbers[0],
    );
    if (matches.length !== 1) return null;

    const record = matches[0];
    return `📌 **Case:** ${record.CrimeNo || record.CaseNo || record.CaseMasterID}\n👤 **Complainant:** ${record.Complainant || "Not recorded"}\n🚨 **Accused:** ${record.AccusedNames || "Not recorded"}`;
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
    : await directIdentityAnswer(params.question);
  if (directAnswer) return directAnswer;

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

  if (typeof data.answer !== "string" || !data.answer.trim()) {
    throw new Error("The Copilot returned an empty response.");
  }

  return data.answer.trim();
}

export type FirDraftContext = {
  allowedValues?: Record<string, string[]>;
  defaults?: Record<string, string>;
};

export async function requestFirDraft(
  complaint: string,
  context?: FirDraftContext,
): Promise<Record<string, string>> {
  const res = await fetch("/api/fir-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    const chatsRef = collection(db, "users", userId, "chat_sessions");
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
    const sessionRef = doc(db, "users", userId, "chat_sessions", session.id);
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
    const sessionRef = doc(db, "users", userId, "chat_sessions", sessionId);
    await deleteDoc(sessionRef);
  } catch (error) {
    console.error("Error deleting chat from Firestore:", error);
  }
}