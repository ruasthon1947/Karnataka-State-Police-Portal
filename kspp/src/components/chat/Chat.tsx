import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KSPPBrandMark } from "../brand/KSPPBrand";
import { useAuth } from "../../context/AuthContext";
import { useLanguage } from "../../context/LanguageContext";
import { useChat } from "../../context/ChatContext";
import {
  askCopilot,
  fetchUserChatsFromFirebase,
  saveChatToFirebase,
  deleteChatFromFirebase,
  type ChatAttachment,
  type ChatMapContext,
  type FirestoreChatSession,
  type ChatMessage,
} from "../../lib/chatApi";
import { VoiceButton } from "./VoiceButton";
import { KSPP_AVATAR_SRC } from "../../assets/kspp-avatar";
import { resolveChatMapContext } from "../../lib/chatMaps";
import ChatRouteCard from "./ChatRouteCard";
import { Clock3, MessageSquareText, Pencil, Plus, Trash2, X } from "lucide-react";

const timeOfDay = () => {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
};

const CHAT_MAP_TIMEOUT_MS = 4_000;

const resolveMapContextWithTimeout = (
  question: string,
  answer: string,
  history: Array<Pick<ChatMessage, "role" | "content">>,
  policeStation: string,
): Promise<ChatMapContext | undefined> => {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<undefined>((resolve) => {
    timeoutId = setTimeout(() => resolve(undefined), CHAT_MAP_TIMEOUT_MS);
  });

  return Promise.race([
    resolveChatMapContext(question, answer, history, policeStation),
    timeout,
  ]).finally(() => clearTimeout(timeoutId));
};

export const Chat: React.FC = () => {
  const { user, isChatBusy, setIsChatBusy } = useAuth();
  const { language, tr } = useLanguage();
  const {
    messages: chatHistory,
    addMessage,
    setMessages: setChatHistory,
    chatHistoryList: savedSessions,
    setChatHistoryList: setSavedSessions,
    currentSessionId,
    setCurrentSessionId,
    startNewSession,
  } = useChat();

  const navigate = useNavigate();
  const userId = user?.employeeId || "";

  const [input, setInput] = useState("");
  const [liveCaption, setLiveCaption] = useState("");
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [pdfStatus, setPdfStatus] = useState<"idle" | "exporting" | "error">("idle");

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitleInput, setEditTitleInput] = useState("");

  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const [, force] = useState(0);

  // Filter out any duplicate sessions by unique session ID
  const uniqueSessions = Array.from(
    new Map(savedSessions.map((session) => [session.id, session])).values()
  ).sort((a, b) => b.timestamp - a.timestamp);

  const scrollToBottom = () => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  };

  useEffect(() => {
    let isSubscribed = true;
    if (userId) {
      fetchUserChatsFromFirebase(userId).then((chats) => {
        if (isSubscribed && chats.length > 0) {
          setSavedSessions(chats);
        }
      });
    }
    return () => {
      isSubscribed = false;
    };
  }, [userId, setSavedSessions]);

  useEffect(() => {
    scrollToBottom();
  }, [chatHistory, isChatBusy]);

  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const loadSession = (session: FirestoreChatSession) => {
    setCurrentSessionId(session.id);
    setChatHistory(session.messages);
    setIsHistoryOpen(false);
  };

  const handleStartNewSession = () => {
    startNewSession();
  };

  const startEditingTitle = (session: FirestoreChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(session.id);
    setEditTitleInput(session.title);
  };

  const saveTitle = (id: string) => {
    const trimmed = editTitleInput.trim();
    if (trimmed && userId) {
      const target = savedSessions.find((s) => s.id === id);
      if (target) {
        const updated = { ...target, title: trimmed };
        setSavedSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
        saveChatToFirebase(userId, updated);
      }
    }
    setEditingSessionId(null);
  };

  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!userId) return;

    deleteChatFromFirebase(userId, id);
    setSavedSessions((prev) => prev.filter((s) => s.id !== id));
    if (currentSessionId === id) {
      setCurrentSessionId(null);
      setChatHistory([]);
    }
  };

  const exportChatToPDF = async () => {
    if (chatHistory.length === 0 || pdfStatus === "exporting") return;
    setPdfStatus("exporting");

    const report = document.createElement("article");
    report.lang = language === "kn" ? "kn" : "en";
    Object.assign(report.style, {
      width: "740px",
      padding: "40px",
      background: "#ffffff",
      color: "#111827",
      fontFamily: '"Noto Sans Kannada", "Nirmala UI", Tunga, Arial, sans-serif',
      fontSize: "14px",
      lineHeight: "1.6",
    });

    const heading = document.createElement("h1");
    heading.textContent = tr("KSPP Assistant report", "KSPP ಸಹಾಯಕ ವರದಿ");
    heading.style.cssText = "margin:0;color:#123b70;font-size:22px";
    const generated = document.createElement("p");
    generated.textContent = `${tr("Generated on:", "ರಚಿಸಿದ ದಿನಾಂಕ:")} ${new Date().toLocaleString(language === "kn" ? "kn-IN" : "en-IN")}`;
    generated.style.cssText = "margin:4px 0 24px;color:#64748b;font-size:11px;border-bottom:1px solid #dbe3ee;padding-bottom:16px";
    report.append(heading, generated);

    for (const message of chatHistory) {
      const section = document.createElement("section");
      section.style.cssText = "break-inside:avoid;margin:0 0 18px;padding:14px 16px;border:1px solid #dbe3ee;border-radius:10px";
      const label = document.createElement("strong");
      label.textContent = message.role === "user" ? tr("Question", "ಪ್ರಶ್ನೆ") : tr("Answer", "ಉತ್ತರ");
      label.style.cssText = `display:block;margin-bottom:6px;color:${message.role === "user" ? "#1d4ed8" : "#166534"}`;
      const content = document.createElement("div");
      content.textContent = message.content.replace(/\*\*/g, "");
      content.style.whiteSpace = "pre-wrap";
      content.style.overflowWrap = "anywhere";
      section.append(label, content);
      report.append(section);
    }

    const footer = document.createElement("p");
    footer.textContent = tr("Official use only · Verify against source records", "ಅಧಿಕೃತ ಬಳಕೆಗೆ ಮಾತ್ರ · ಮೂಲ ದಾಖಲೆಗಳೊಂದಿಗೆ ಪರಿಶೀಲಿಸಿ");
    footer.style.cssText = "margin:24px 0 0;text-align:center;color:#64748b;font-size:10px";
    report.append(footer);
    document.body.append(report);

    try {
      await document.fonts.ready;
      const { default: html2pdf } = await import("html2pdf.js");
      await html2pdf()
        .set({
          margin: 8,
          filename: `Karnataka_Police_Chat_Report_${new Date().toISOString().slice(0, 10)}.pdf`,
          image: { type: "jpeg", quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true, letterRendering: true },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        })
        .from(report)
        .save();
      setPdfStatus("idle");
    } catch {
      setPdfStatus("error");
      window.setTimeout(() => setPdfStatus("idle"), 3500);
    } finally {
      report.remove();
    }
  };

  const send = async (text?: string) => {
    const trimmed =
      (text ?? input).trim() ||
      (attachment ? "Please analyze the attached file and summarize the relevant information." : "");
    if (!trimmed || isChatBusy) return;

    const outgoingAttachment = attachment;
    const recentHistory = chatHistory.slice(-6).map(({ role, content }) => ({ role, content }));
    const visibleQuestion = outgoingAttachment
      ? `${trimmed}\n📎 **Attachment:** ${outgoingAttachment.name}`
      : trimmed;

    // Reuse existing session ID or assign a new one
    const activeSessionId = currentSessionId || crypto.randomUUID();
    if (!currentSessionId) {
      setCurrentSessionId(activeSessionId);
    }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: visibleQuestion,
      ts: Date.now(),
    };

    const updatedMessagesWithUser = [...chatHistory, userMsg];
    addMessage(userMsg);

    setInput("");
    setAttachment(null);
    setAttachmentError("");
    setIsChatBusy(true);
    scrollToBottom();

    try {
      const detectedLang = /[\u0C80-\u0CFF]/.test(trimmed) ? "kn" : language === "kn" ? "kn" : "en";
      const reply = await askCopilot({
        question: trimmed,
        language: detectedLang,
        history: recentHistory,
        attachment: outgoingAttachment || undefined,
      });

      const assistantId = crypto.randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: reply,
        ts: Date.now(),
      };

      // Render the completed answer immediately. Map enrichment and remote
      // history persistence are secondary work and must never keep the chat
      // spinner active after the AI response is available.
      addMessage(assistantMsg);

      const finalMessages = [...updatedMessagesWithUser, assistantMsg];
      const existingSession = savedSessions.find((session) => session.id === activeSessionId);
      const sessionPayload: FirestoreChatSession = {
        id: activeSessionId,
        title:
          existingSession?.title ||
          updatedMessagesWithUser.find((message) => message.role === "user")?.content.slice(0, 30) ||
          "Chat Session",
        timestamp: Date.now(),
        messages: finalMessages,
      };

      setSavedSessions((prev) => {
        const exists = prev.some((session) => session.id === activeSessionId);
        if (exists) {
          return prev.map((session) =>
            session.id === activeSessionId ? sessionPayload : session,
          );
        }
        return [sessionPayload, ...prev];
      });
      setIsChatBusy(false);

      void (async () => {
        let persistedSession = sessionPayload;

        if (!outgoingAttachment) {
          const mapContext = await resolveMapContextWithTimeout(
            trimmed,
            reply,
            recentHistory,
            user?.policeStation || "",
          );

          if (mapContext) {
            const enrichedAssistant = { ...assistantMsg, mapContext };
            const enrichedMessages = finalMessages.map((message) =>
              message.id === assistantId ? enrichedAssistant : message,
            );
            persistedSession = { ...sessionPayload, messages: enrichedMessages };

            setChatHistory((previous) =>
              previous.map((message) =>
                message.id === assistantId ? enrichedAssistant : message,
              ),
            );
            setSavedSessions((previous) =>
              previous.map((session) =>
                session.id === activeSessionId ? persistedSession : session,
              ),
            );
          }
        }

        if (userId) {
          await saveChatToFirebase(userId, persistedSession);
        }
      })();
    } catch (err) {
      const errorMsg = tr(
        navigator.onLine
          ? "Sorry, I couldn't process that request. Please try again."
          : "You are offline. Reconnect, then send the message again.",
        navigator.onLine
          ? "ಕ್ಷಮಿಸಿ, ಆ ವಿನಂತಿಯನ್ನು ಪ್ರಕ್ರಿಯೆಗೊಳಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ."
          : "ನೀವು ಆಫ್‌ಲೈನ್‌ನಲ್ಲಿದ್ದೀರಿ. ಮರುಸಂಪರ್ಕಿಸಿದ ನಂತರ ಸಂದೇಶವನ್ನು ಮತ್ತೆ ಕಳುಹಿಸಿ."
      );
      addMessage({ id: crypto.randomUUID(), role: "assistant", content: errorMsg, ts: Date.now() });
    } finally {
      setIsChatBusy(false);
    }
  };

  const selectAttachment = async (file: File) => {
    setAttachmentError("");
    setAttachment(null);
    setAttachmentLoading(true);
    const extension = file.name.toLowerCase().split(".").pop() || "";
    const inferredTypes: Record<string, string> = {
      csv: "text/csv",
      json: "application/json",
      md: "text/markdown",
      txt: "text/plain",
      log: "text/plain",
    };
    const mimeType = file.type || inferredTypes[extension] || "application/octet-stream";
    const textTypes = new Set(["text/plain", "text/csv", "text/markdown", "application/json"]);

    if (!textTypes.has(mimeType)) {
      setAttachmentError(
        tr("This assistant currently supports TXT, CSV, JSON, Markdown and LOG files.", "ಈ ಸಹಾಯಕ ಪ್ರಸ್ತುತ TXT, CSV, JSON, Markdown ಮತ್ತು LOG ಕಡತಗಳನ್ನು ಬೆಂಬಲಿಸುತ್ತದೆ.")
      );
      setAttachmentLoading(false);
      return;
    }
    if (file.size > 2_000_000) {
      setAttachmentError(tr("The attachment must be 2 MB or smaller.", "ಲಗತ್ತು 2 MB ಅಥವಾ ಅದಕ್ಕಿಂತ ಚಿಕ್ಕದಾಗಿರಬೇಕು."));
      setAttachmentLoading(false);
      return;
    }

    try {
      const content = (await file.text()).slice(0, 12_000);
      if (!content.trim()) throw new Error(tr("The selected file is empty.", "ಆಯ್ಕೆ ಮಾಡಿದ ಕಡತ ಖಾಲಿಯಾಗಿದೆ."));
      setAttachment({ name: file.name, mimeType, content });
    } catch (fileError) {
      setAttachment(null);
      setAttachmentError(
        fileError instanceof Error ? fileError.message : "The selected file could not be read."
      );
    } finally {
      setAttachmentLoading(false);
    }
  };

  const tod = timeOfDay();
  const firstName = (user?.name ?? "Officer").split(/\s+/)[0];
  const greeting =
    language === "kn"
      ? tod === "morning"
        ? "ಶುಭೋದಯ, ಅಧಿಕಾರಿಯವರೇ."
        : tod === "afternoon"
          ? "ಶುಭ ಮಧ್ಯಾಹ್ನ, ಅಧಿಕಾರಿಯವರೇ."
          : "ಶುಭ ಸಂಜೆ, ಅಧಿಕಾರಿಯವರೇ."
      : tod === "morning"
        ? `Good morning, ${firstName}.`
        : tod === "afternoon"
          ? `Good afternoon, ${firstName}.`
          : `Good evening, ${firstName}.`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink text-white">
      {/* Top Header */}
      <div className="flex items-center gap-3 border-b border-line bg-ink px-3 py-3 sm:px-6">
        <div className="flex items-center gap-2 text-sm">
          <KSPPBrandMark size="sm" decorative />
          <span className="hidden text-white font-medium sm:inline">
            {tr("KSPP Assistant", "KSPP ಸಹಾಯಕ")}
          </span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => navigate("/fir/new")}
          className="min-h-9 rounded-md border border-line bg-panel px-3 py-1.5 text-xs font-medium text-white transition hover:bg-shell"
        >
          {tr("New FIR", "ಹೊಸ ಎಫ್‌ಐಆರ್")}
        </button>
        <button
          type="button"
          onClick={exportChatToPDF}
          disabled={chatHistory.length === 0 || pdfStatus === "exporting"}
          title={pdfStatus === "error" ? tr("PDF export failed. Try again.", "PDF ರಫ್ತು ವಿಫಲವಾಗಿದೆ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.") : undefined}
          className="min-h-9 rounded-md border border-line bg-panel px-3 py-1.5 text-xs font-medium text-white transition hover:bg-shell disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pdfStatus === "exporting" ? tr("Exporting…", "ರಫ್ತು ಮಾಡಲಾಗುತ್ತಿದೆ…") : pdfStatus === "error" ? tr("Try PDF again", "PDF ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ") : tr("Export PDF", "PDF ರಫ್ತು")}
        </button>
        <button
          onClick={handleStartNewSession}
          className="min-h-9 rounded-md border border-brand/30 bg-brand/15 px-2.5 py-1.5 text-xs text-white transition hover:bg-brand/25 sm:px-3"
        >
          <span className="flex items-center gap-1.5">
            <Plus size={14} aria-hidden="true" />
            <span className="hidden sm:inline">{tr("New chat", "ಹೊಸ ಸಂಭಾಷಣೆ")}</span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => setIsHistoryOpen(!isHistoryOpen)}
          aria-expanded={isHistoryOpen}
          aria-controls="chat-recents"
          className="min-h-9 rounded-md border border-line bg-panel px-2.5 text-white transition hover:bg-shell sm:px-3"
        >
          <span className="flex items-center gap-1.5">
            {isHistoryOpen ? <X size={15} aria-hidden="true" /> : <Clock3 size={15} aria-hidden="true" />}
            <span className="hidden sm:inline">{tr("Recents", "ಇತ್ತೀಚಿನವು")}</span>
            {uniqueSessions.length > 0 && (
              <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand">
                {uniqueSessions.length}
              </span>
            )}
          </span>
        </button>
      </div>

      {/* Main Workspace */}
      <div className="flex min-h-0 flex-1 overflow-hidden relative">
        <div className="flex flex-1 flex-col min-h-0 min-w-0">
          {chatHistory.length === 0 ? (
            <EmptyCanvas
              greeting={greeting}
              help={tr("How can I help you today?", "ಇಂದು ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?")}
            />
          ) : (
            <MessageList ref={chatContainerRef} messages={chatHistory} busy={isChatBusy} tr={tr} />
          )}

          <div className="shrink-0 px-3 pb-4 pt-3 sm:px-6 sm:pb-7 sm:pt-4">
            <div className="max-w-3xl mx-auto">
              <Composer
                value={input}
                onChange={setInput}
                onSend={() => send()}
                onVoiceResult={(text) => { setLiveCaption(""); send(text); }}
                liveCaption={liveCaption}
                onLiveTranscript={setLiveCaption}
                attachment={attachment}
                attachmentError={attachmentError}
                attachmentLoading={attachmentLoading}
                onAttachmentSelected={selectAttachment}
                onRemoveAttachment={() => {
                  setAttachment(null);
                  setAttachmentError("");
                }}
                busy={isChatBusy}
                tr={tr}
                language={language === "kn" ? "kn" : "en"}
              />

              <p className="text-[11px] text-muted text-center mt-2">
                {tr(
                  "Copilot generates drafts and queries - verify against source records before any official action.",
                  "ಕೋಪೈಲಟ್ ಕರಡುಗಳು ಮತ್ತು ಪ್ರಶ್ನೆಗಳನ್ನು ರಚಿಸುತ್ತದೆ - ಯಾವುದೇ ಅಧಿಕೃತ ಕ್ರಮಕ್ಕೂ ಮೊದಲು ಮೂಲ ದಾಖಲೆಗಳೊಂದಿಗೆ ಪರಿಶೀಲಿಸಿ."
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        {isHistoryOpen && (
          <>
            <button
              type="button"
              aria-label={tr("Close recents", "ಇತ್ತೀಚಿನವುಗಳನ್ನು ಮುಚ್ಚಿ")}
              onClick={() => setIsHistoryOpen(false)}
              className="absolute inset-0 z-20 bg-black/35 sm:hidden"
            />
            <aside
              id="chat-recents"
              aria-label={tr("Recent chatbot queries", "ಇತ್ತೀಚಿನ ಚಾಟ್‌ಬಾಟ್ ಪ್ರಶ್ನೆಗಳು")}
              className="absolute inset-y-0 right-0 z-30 flex h-full w-[min(22rem,calc(100%-1rem))] shrink-0 flex-col border-l border-line bg-panel p-4 shadow-2xl sm:static sm:z-auto sm:w-80 sm:shadow-xl"
            >
              <div className="flex items-center justify-between pb-3 mb-3 border-b border-line">
                <h3 className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-2">
                  <MessageSquareText size={15} aria-hidden="true" /> {tr("Recent queries", "ಇತ್ತೀಚಿನ ಪ್ರಶ್ನೆಗಳು")}
                </h3>
                <span className="text-[10px] bg-ink border border-line text-muted px-2 py-0.5 rounded-full font-medium">
                  {uniqueSessions.length}
                </span>
              </div>

              <div className="flex-1 space-y-2 overflow-y-auto pr-1">
                {uniqueSessions.length === 0 ? (
                  <div className="text-center py-8 text-muted">
                    <p className="text-xs font-medium">{tr("No previous sessions", "ಯಾವುದೇ ಹಿಂದಿನ ಸೆಷನ್‌ಗಳಿಲ್ಲ")}</p>
                    <p className="text-[11px] opacity-75 mt-1">
                      {tr("Start chatting to build history", "ಇತಿಹಾಸವನ್ನು ರಚಿಸಲು ಸಂಭಾಷಣೆಯನ್ನು ಪ್ರಾರಂಭಿಸಿ")}
                    </p>
                  </div>
                ) : (
                  uniqueSessions.map((session) => {
                    const isActive = currentSessionId === session.id;
                    const isEditing = editingSessionId === session.id;
                    const previousQueries = session.messages.filter((message) => message.role === "user");
                    const latestQuery =
                      previousQueries[previousQueries.length - 1]?.content || session.title;

                    return (
                      <div
                        key={session.id}
                        onClick={() => loadSession(session)}
                        className={`group relative flex items-center justify-between p-3 rounded-xl border text-xs cursor-pointer transition-all duration-150 ${isActive
                          ? "bg-brand/20 border-brand text-slate-900 dark:text-white font-semibold shadow-sm ring-1 ring-brand/30"
                          : "bg-slate-500/10 border-slate-400/20 text-slate-800 dark:text-slate-100 hover:bg-slate-500/20 hover:border-slate-400/40"
                          }`}
                      >
                        {isActive && <div className="absolute left-0 top-2 bottom-2 w-1 bg-brand rounded-r" />}

                        <div className="flex-1 min-w-0 pr-2 pl-1">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editTitleInput}
                              onChange={(e) => setEditTitleInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveTitle(session.id);
                                if (e.key === "Escape") setEditingSessionId(null);
                              }}
                              onBlur={() => saveTitle(session.id)}
                              autoFocus
                              onClick={(e) => e.stopPropagation()}
                              className="w-full bg-ink border border-brand text-slate-900 dark:text-white rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
                            />
                          ) : (
                            <>
                              <p className="font-semibold truncate text-slate-900 dark:text-slate-100">
                                {session.title}
                              </p>
                              <p className="mt-1 line-clamp-2 text-[11px] font-normal leading-4 text-slate-600 dark:text-slate-300">
                                {latestQuery}
                              </p>
                              <p className="mt-1.5 text-[10px] font-normal text-slate-500 dark:text-slate-400">
                                {new Date(session.timestamp).toLocaleDateString([], {
                                  day: "numeric",
                                  month: "short",
                                })}{" · "}
                                {new Date(session.timestamp).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}{" · "}
                                {previousQueries.length} {tr("queries", "ಪ್ರಶ್ನೆಗಳು")}
                              </p>
                            </>
                          )}
                        </div>

                        {!isEditing && (
                          <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={(e) => startEditingTitle(session, e)}
                              className="p-1.5 rounded hover:bg-slate-400/20 text-slate-700 dark:text-slate-300 transition"
                              title={tr("Rename Chat", "ಸೆಷನ್ ಮರುನಾಮಕರಣ ಮಾಡಿ")}
                            >
                              <Pencil size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => handleDeleteSession(session.id, e)}
                              className="p-1.5 rounded hover:bg-red-500/20 text-red-500 transition"
                              title={tr("Delete Chat", "ಸೆಷನ್ ಅಳಿಸಿ")}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </aside>
          </>
        )}
      </div>
    </div>
  );
};

const EmptyCanvas: React.FC<{ greeting: string; help: string }> = ({ greeting, help }) => (
  <div className="flex-1 flex items-center justify-center dotted-bg">
    <div className="px-4 text-center sm:px-6">
      <KSPPBrandMark size="lg" className="mb-4" decorative />
      <h1 className="font-schibsted text-2xl font-semibold text-white sm:text-3xl md:text-4xl">
        {greeting}
      </h1>
      <p className="text-muted text-sm mt-2 max-w-md mx-auto">{help}</p>
    </div>
  </div>
);

const MessageList = React.forwardRef<
  HTMLDivElement,
  { messages: any[]; busy: boolean; tr: (en: string, kn: string) => string }
>(({ messages, busy, tr }, ref) => (
  <div ref={ref} className="min-h-0 flex-1 overflow-y-auto bg-ink px-3 py-5 sm:px-6 sm:py-8">
    <div className="mx-auto max-w-3xl space-y-5 sm:space-y-6">
      <div className="hidden print:block pb-4 mb-6 border-b border-line text-white">
        <h1 className="text-xl font-bold">{tr("KSPP Assistant", "KSPP ಸಹಾಯಕ")}</h1>
        <p className="text-xs text-muted">
          {tr("Official Chat Conversation Transcript", "ಅಧಿಕೃತ ಸಂಭಾಷಣೆ ಪ್ರತಿ")}
        </p>
        <p className="text-[10px] text-muted mt-1">
          {tr("Generated on:", "ರಚಿಸಿದ ದಿನಾಂಕ:")} {new Date().toLocaleString()}
        </p>
      </div>

      {messages.map((m) => (
        <Bubble key={m.id} msg={m} tr={tr} />
      ))}
      {busy && <TypingBubble />}
    </div>
  </div>
));
MessageList.displayName = "MessageList";

const Bubble: React.FC<{ msg: ChatMessage; tr: (en: string, kn: string) => string }> = ({
  msg,
  tr,
}) => {
  const isUser = msg.role === "user";
  return (
    <div className={`flex items-start gap-3 ${isUser ? "justify-end" : ""}`}>
      {!isUser && (
        <img
          src={KSPP_AVATAR_SRC}
          alt="KSPP"
          className="h-8 w-8 rounded-full object-cover shrink-0 border border-line"
        />
      )}
      <div
        className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap sm:max-w-[86%] sm:px-4 sm:py-3 ${isUser ? "bg-brand text-white" : "bg-shell text-white border border-line max-h-72 overflow-y-auto"
          }`}
      >
        <Formatted text={msg.content} />
        {!isUser && msg.mapContext ? <ChatRouteCard context={msg.mapContext} tr={tr} /> : null}
      </div>
      {isUser && (
        <div className="h-8 w-8 rounded-full bg-panel border border-line grid place-items-center text-xs text-muted shrink-0">
          U
        </div>
      )}
    </div>
  );
};

const TypingBubble = () => (
  <div className="flex items-start gap-3">
    <img
      src={KSPP_AVATAR_SRC}
      alt="KSPP"
      className="h-8 w-8 rounded-full object-cover shrink-0 border border-line"
    />
    <div className="bg-shell border border-line rounded-2xl px-4 py-3 flex gap-1.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  </div>
);

const Formatted: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
      /^\*\*[^*]+\*\*$/.test(p) ? (
        <strong key={i} className="text-white font-semibold">
          {p.slice(2, -2)}
        </strong>
      ) : (
        <span key={i}>{p}</span>
      )
    )}
  </>
);

const Composer: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onVoiceResult: (text: string) => void;
  liveCaption: string;
  onLiveTranscript: (text: string) => void;
  attachment: ChatAttachment | null;
  attachmentError: string;
  attachmentLoading: boolean;
  onAttachmentSelected: (file: File) => void;
  onRemoveAttachment: () => void;
  busy: boolean;
  tr: (en: string, kn: string) => string;
  language: "en" | "kn";
}> = ({
  value,
  onChange,
  onSend,
  onVoiceResult,
  liveCaption,
  onLiveTranscript,
  attachment,
  attachmentError,
  attachmentLoading,
  onAttachmentSelected,
  onRemoveAttachment,
  busy,
  tr,
  language,
}) => {
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    const fileRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.style.height = "auto";
      ta.style.height = Math.min(180, ta.scrollHeight) + "px";
    }, [value]);

    return (
      <div className="rounded-2xl border border-line/60 bg-white dark:bg-[#14171f] px-3 py-2.5 shadow-[0_2px_14px_rgba(15,23,42,0.08)] dark:shadow-[0_2px_18px_rgba(0,0,0,0.35)] transition-all duration-200 ease-out focus-within:border-brand/50 focus-within:shadow-[0_2px_20px_rgba(37,99,235,0.15)] sm:px-4 sm:py-3">
        {liveCaption && (
          <div className="mb-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 shadow-[0_0_12px_rgba(239,68,68,0.15)]">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-red-400">{tr("Live Caption", "ನೇರ ಉಪಶೀರ್ಷಿಕೆ")}</span>
            </div>
            <p className="text-sm leading-relaxed text-blue/90 break-words">
              {liveCaption}
              <span className="inline-block w-0.5 h-4 bg-red-400 animate-pulse ml-0.5 align-text-bottom" />
            </p>
          </div>
        )}
        {attachment && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-brand/30 bg-brand/10 px-3 py-2 text-xs text-slate-800 dark:text-white">
            <span aria-hidden="true">📎</span>
            <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
            <span className="shrink-0 text-[10px] text-sage">{tr("Ready", "ಸಿದ್ಧ")}</span>
            <button
              type="button"
              onClick={onRemoveAttachment}
              className="rounded px-1.5 py-0.5 text-muted hover:bg-panel hover:text-white"
            >
              ×
            </button>
          </div>
        )}
        {attachmentError && (
          <p className="mb-2 text-xs text-red-300" role="alert">
            {attachmentError}
          </p>
        )}
        {attachmentLoading && (
          <p className="mb-2 text-xs text-brand" role="status" aria-live="polite">
            {tr("Reading file…", "ಕಡತ ಓದಲಾಗುತ್ತಿದೆ…")}
          </p>
        )}
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={tr(
            "Ask the Copilot - try 'FIRs in Whitefield last week' or 'disposal rate'",
            "ಕೋಪೈಲಟ್ ಅನ್ನು ಕೇಳಿ - 'ಕಳೆದ ವಾರ ವೈಟ್‌ಫೀಲ್ಡ್‌ನ ಎಫ್‌ಐಆರ್‌ಗಳು' ಅಥವಾ 'ವಿಲೇವಾರಿ ದರ' ಎಂದು ಪ್ರಯತ್ನಿಸಿ"
          )}
          rows={1}
          className="w-full bg-transparent text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-muted resize-none text-sm leading-relaxed !outline-none !shadow-none !border-none focus:!outline-none focus:!shadow-none focus:!border-none focus:!ring-0"
        />
        <div className="flex items-center gap-1 mt-1">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".txt,.csv,.json,.md,.log,text/plain,text/csv,text/markdown,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onAttachmentSelected(file);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy || attachmentLoading}
            aria-label={tr("Attach a supported text file", "ಬೆಂಬಲಿತ ಪಠ್ಯ ಕಡತ ಲಗತ್ತಿಸಿ")}
            title={tr("Attach TXT, CSV, JSON, Markdown or LOG (maximum 2 MB)", "TXT, CSV, JSON, Markdown ಅಥವಾ LOG ಲಗತ್ತಿಸಿ (ಗರಿಷ್ಠ 2 MB)")}
            className="h-8 w-8 grid place-items-center rounded-md text-muted hover:text-white hover:bg-panel transition"
          >
            ＋
          </button>

          <VoiceButton
            language={language}
            onResult={(text) => { onLiveTranscript(""); onVoiceResult(text); }}
            disabled={busy}
            onLiveTranscript={onLiveTranscript}
          />

          <div className="flex-1" />
          <button
            onClick={onSend}
            disabled={busy || attachmentLoading || (!value.trim() && !attachment)}
            aria-label={tr("Send message", "ಸಂದೇಶ ಕಳುಹಿಸಿ")}
            className="h-8 w-8 grid place-items-center rounded-full bg-brand text-white disabled:opacity-40 hover:bg-brand/90 transition"
          >
            ↗
          </button>
        </div>
      </div>
    );
  };

export default Chat;










