import { fetchCases } from "./cases";

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
}): Promise<string> {
  const directAnswer = await directIdentityAnswer(params.question);
  if (directAnswer) return directAnswer;

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: params.question,
      language: params.language,
    }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || !data?.ok) {
    const serverMessage = data?.error || `HTTP ${res.status}`;
    console.error("Chat API error:", serverMessage);
    throw new Error(serverMessage);
  }

  return data.answer;
}

export async function requestFirDraft(complaint: string): Promise<Record<string, string>> {
  const res = await fetch("/api/fir-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ complaint }),
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
