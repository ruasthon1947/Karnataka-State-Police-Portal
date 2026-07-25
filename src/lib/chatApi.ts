export async function askCopilot(params: {
  question: string;
  language: "en" | "kn";
}): Promise<string> {
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
