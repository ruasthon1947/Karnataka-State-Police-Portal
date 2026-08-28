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
  type FirestoreChatSession,
  type ChatMessage,
} from "../../lib/chatApi";
import { VoiceButton } from "./VoiceButton";
import { jsPDF } from "jspdf";
import { KSPP_AVATAR_SRC } from "../../assets/kspp-avatar";
import { resolveChatMapContext } from "../../lib/chatMaps";
import ChatRouteCard from "./ChatRouteCard";

const timeOfDay = () => {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
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
    startNewSession,
  } = useChat();

  const navigate = useNavigate();
  const userId = user?.employeeId || "";

  const [input, setInput] = useState("");
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState("");

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitleInput, setEditTitleInput] = useState("");

  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const [, force] = useState(0);

  // Filter out any duplicate sessions by unique session ID
  const uniqueSessions = Array.from(
    new Map(savedSessions.map((session) => [session.id, session])).values()
  );

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
  };

  const handleStartNewSession = () => {
    setCurrentSessionId(null);
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
      handleStartNewSession();
    }
  };

  const exportChatToPDF = async () => {
    if (chatHistory.length === 0) return;

    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const MARGIN = 48;
    const LINE_HEIGHT = 16;
    const contentWidth = pageWidth - MARGIN * 2;
    let y = MARGIN;

    const ensureSpace = (needed: number) => {
      if (y + needed > pageHeight - MARGIN) {
        doc.addPage();
        y = MARGIN;
      }
    };

    try {
      doc.addImage(KSPP_AVATAR_SRC, "PNG", MARGIN, y - 8, 28, 28);
    } catch {}

    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(tr("KSPP Assistant", "KSPP ಸಹಾಯಕ"), MARGIN + 36, y + 8);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(
      `${tr("Generated on:", "ರಚಿಸಿದ ದಿನಾಂಕ:")} ${new Date().toLocaleString()}`,
      pageWidth - MARGIN,
      y + 8,
      { align: "right" }
    );
    doc.setTextColor(20);
    y += 40;
    doc.setDrawColor(200);
    doc.line(MARGIN, y, pageWidth - MARGIN, y);
    y += 24;

    const sanitizeForPdfFont = (text: string): string =>
      text
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[\u2010-\u2015\u2212]/g, "-")
        .replace(/[\u00A0\u2000-\u200A\u202F\u205F]/g, " ")
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u2026/g, "...");

    const writeFormattedParagraph = (rawInput: string) => {
      const raw = sanitizeForPdfFont(rawInput);
      const segments = raw
        .split(/(\*\*[^*]+\*\*)/g)
        .filter(Boolean)
        .map((seg) => {
          const bold = /^\*\*[^*]+\*\*$/.test(seg);
          return { text: bold ? seg.slice(2, -2) : seg, bold };
        });

      let cursorX = MARGIN;
      doc.setFontSize(11);

      for (const seg of segments) {
        const words = seg.text.split(/(\s+)/);
        for (const word of words) {
          if (word === "") continue;
          doc.setFont("helvetica", seg.bold ? "bold" : "normal");

          if (word === "\n") {
            cursorX = MARGIN;
            if (y + LINE_HEIGHT > pageHeight - MARGIN) {
              doc.addPage();
              y = MARGIN;
            } else {
              y += LINE_HEIGHT;
            }
            continue;
          }

          const wordWidth = doc.getTextWidth(word);
          const needsWrap = cursorX + wordWidth > MARGIN + contentWidth;

          if (needsWrap) {
            cursorX = MARGIN;
          }
          if (y + LINE_HEIGHT > pageHeight - MARGIN) {
            doc.addPage();
            y = MARGIN;
            cursorX = MARGIN;
          } else if (needsWrap) {
            y += LINE_HEIGHT;
          }

          doc.text(word, cursorX, y);
          cursorX += wordWidth;
        }
      }
      y += LINE_HEIGHT + 10;
    };

    for (const msg of chatHistory) {
      const isUser = msg.role === "user";
      ensureSpace(LINE_HEIGHT);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(isUser ? 15 : 15, isUser ? 61 : 110, isUser ? 145 : 60);
      doc.text(isUser ? tr("Question:", "ಪ್ರಶ್ನೆ:") : tr("Answer:", "ಉತ್ತರ:"), MARGIN, y);
      y += LINE_HEIGHT;
      doc.setTextColor(20);

      msg.content.split(/\n+/).forEach((line: string) => {
        if (line.trim()) writeFormattedParagraph(line);
      });
    }

    const pageCount = doc.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(140);
      doc.text(
        `${tr("Official use only", "ಅಧಿಕೃತ ಬಳಕೆಗೆ ಮಾತ್ರ")} · ${tr("Page", "ಪುಟ")} ${i} ${tr("of", "ರಲ್ಲಿ")} ${pageCount}`,
        pageWidth / 2,
        pageHeight - 20,
        { align: "center" }
      );
    }

    doc.save(`Karnataka_Police_Chat_Report_${new Date().toISOString().slice(0, 10)}.pdf`);
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
      const reply = await askCopilot({
        question: trimmed,
        language: language === "kn" ? "kn" : "en",
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

      const mapContext = outgoingAttachment
        ? undefined
        : await resolveChatMapContext(trimmed, reply, recentHistory, user?.policeStation || "");

      if (mapContext) {
        assistantMsg.mapContext = mapContext;
      }

      addMessage(assistantMsg);

      const finalMessages = [...updatedMessagesWithUser, assistantMsg];
      const sessionPayload: FirestoreChatSession = {
        id: activeSessionId,
        title: updatedMessagesWithUser[0]?.content.slice(0, 30) || "Chat Session",
        timestamp: Date.now(),
        messages: finalMessages,
      };

      // Persist session directly to Firebase
      if (userId) {
        await saveChatToFirebase(userId, sessionPayload);

        setSavedSessions((prev) => {
          const exists = prev.some((s) => s.id === activeSessionId);
          if (exists) {
            return prev.map((s) => (s.id === activeSessionId ? sessionPayload : s));
          }
          return [sessionPayload, ...prev];
        });
      }
    } catch (err) {
      console.error(err);
      const errorMsg = tr(
        "Sorry, I couldn't process that request. Please try again.",
        "ಕ್ಷಮಿಸಿ, ಆ ವಿನಂತಿಯನ್ನು ಪ್ರಕ್ರಿಯೆಗೊಳಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ."
      );
      addMessage({ id: crypto.randomUUID(), role: "assistant", content: errorMsg, ts: Date.now() });
    } finally {
      setIsChatBusy(false);
    }
  };

  const selectAttachment = async (file: File) => {
    setAttachmentError("");
    const extension = file.name.toLowerCase().split(".").pop() || "";
    const inferredTypes: Record<string, string> = {
      csv: "text/csv",
      json: "application/json",
      md: "text/markdown",
      pdf: "application/pdf",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      txt: "text/plain",
      webp: "image/webp",
    };
    const mimeType = file.type || inferredTypes[extension] || "application/octet-stream";
    const textTypes = new Set(["text/plain", "text/csv", "text/markdown", "application/json"]);
    const binaryTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

    if (!textTypes.has(mimeType) && !binaryTypes.has(mimeType)) {
      setAttachmentError(
        tr("Upload TXT, CSV, JSON, Markdown, PDF, JPG, PNG, or WebP.", "TXT, CSV, JSON, Markdown, PDF, JPG, PNG ಅಥವಾ WebP ಕಡತವನ್ನು ಅಪ್‌ಲೋಡ್ ಮಾಡಿ.")
      );
      return;
    }
    if (file.size > 2_000_000) {
      setAttachmentError(tr("The attachment must be 2 MB or smaller.", "ಲಗತ್ತು 2 MB ಅಥವಾ ಅದಕ್ಕಿಂತ ಚಿಕ್ಕದಾಗಿರಬೇಕು."));
      return;
    }

    try {
      if (textTypes.has(mimeType)) {
        const content = (await file.text()).slice(0, 12_000);
        if (!content.trim()) throw new Error(tr("The selected file is empty.", "ಆಯ್ಕೆ ಮಾಡಿದ ಕಡತ ಖಾಲಿಯಾಗಿದೆ."));
        setAttachment({ name: file.name, mimeType, content });
        return;
      }

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () =>
          reject(new Error(tr("The selected file could not be read.", "ಆಯ್ಕೆ ಮಾಡಿದ ಕಡತವನ್ನು ಓದಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ.")));
        reader.readAsDataURL(file);
      });
      const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
      setAttachment({ name: file.name, mimeType, data });
    } catch (fileError) {
      setAttachment(null);
      setAttachmentError(
        fileError instanceof Error ? fileError.message : "The selected file could not be read."
      );
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
          disabled={chatHistory.length === 0}
          className="min-h-9 rounded-md border border-line bg-panel px-3 py-1.5 text-xs font-medium text-white transition hover:bg-shell disabled:cursor-not-allowed disabled:opacity-40"
        >
          {tr("Export PDF", "PDF ರಫ್ತು")}
        </button>
        <button
          onClick={handleStartNewSession}
          className="min-h-9 rounded-md border border-brand/30 bg-brand/15 px-3 py-1.5 text-xs text-white transition hover:bg-brand/25"
        >
          {tr("New session", "ಹೊಸ ಸೆಷನ್")}
        </button>

        <button
          type="button"
          onClick={() => setIsHistoryOpen(!isHistoryOpen)}
          className="min-h-9 min-w-9 grid place-items-center rounded-md border border-line bg-panel text-white transition hover:bg-shell"
        >
          {isHistoryOpen ? "✕" : "☰"}
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
                onVoiceResult={(text) => send(text)}
                attachment={attachment}
                attachmentError={attachmentError}
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
          <aside className="w-80 border-l border-line bg-panel p-4 flex flex-col h-full shrink-0 shadow-xl backdrop-blur-md transition-all">
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-line">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-2">
                <span>💬</span> {tr("Chat History", "ಸಂಭಾಷಣೆ ಇತಿಹಾಸ")}
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

                  return (
                    <div
                      key={session.id}
                      onClick={() => loadSession(session)}
                      className={`group relative flex items-center justify-between p-3 rounded-xl border text-xs cursor-pointer transition-all duration-150 ${
                        isActive
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
                            <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                              {new Date(session.timestamp).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
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
                            ✏️
                          </button>
                          <button
                            type="button"
                            onClick={(e) => handleDeleteSession(session.id, e)}
                            className="p-1.5 rounded hover:bg-red-500/20 text-red-500 transition"
                            title={tr("Delete Chat", "ಸೆಷನ್ ಅಳಿಸಿ")}
                          >
                            🗑️
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </aside>
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
        className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap sm:max-w-[86%] sm:px-4 sm:py-3 ${
          isUser ? "bg-brand text-white" : "bg-shell text-white border border-line"
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
  attachment: ChatAttachment | null;
  attachmentError: string;
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
  attachment,
  attachmentError,
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
      {attachment && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-brand/30 bg-brand/10 px-3 py-2 text-xs text-slate-800 dark:text-white">
          <span aria-hidden="true">📎</span>
          <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
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
          accept=".txt,.csv,.json,.md,.pdf,.jpg,.jpeg,.png,.webp,text/plain,text/csv,text/markdown,application/json,application/pdf,image/jpeg,image/png,image/webp"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onAttachmentSelected(file);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="h-8 w-8 grid place-items-center rounded-md text-muted hover:text-white hover:bg-panel transition"
        >
          ＋
        </button>

        <VoiceButton language={language} onResult={(text) => onVoiceResult(text)} disabled={busy} />

        <div className="flex-1" />
        <button
          onClick={onSend}
          disabled={busy || (!value.trim() && !attachment)}
          className="h-8 w-8 grid place-items-center rounded-full bg-brand text-white disabled:opacity-40 hover:bg-brand/90 transition"
        >
          ↗
        </button>
      </div>
    </div>
  );
};

export default Chat;