// src/pages/Chat.tsx
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
// @ts-ignore - html2pdf fallback import for environments without strict type declarations
import { KSPPBrandMark } from "../brand/KSPPBrand";
import { useAuth } from "../../context/AuthContext";
import { useLanguage } from "../../context/LanguageContext";
import { askCopilot } from "../../lib/chatApi";
import { VoiceButton } from "./VoiceButton";

type Msg = { id: string; role: "user" | "assistant"; content: string; ts: number };

const timeOfDay = () => {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
};

export const Chat: React.FC = () => {
  const { user, chatHistory, setChatHistory, isChatBusy, setIsChatBusy } = useAuth();
  const { language, tr } = useLanguage();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  
  // References for scrolling and target PDF export element
  const endRef = useRef<HTMLDivElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const [, force] = useState(0);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatHistory, isChatBusy]);
  useEffect(() => { const id = setInterval(() => force((n) => n + 1), 60_000); return () => clearInterval(id); }, []);

  // 🚀 PDF Export Handler
  const exportChatToPDF = async () => {
    const element = chatListRef.current;
    if (!element) {
      console.warn("Chat container element not found for export.");
      return;
    }

    const opt = {
      margin:       [10, 10, 10, 10], // top, left, bottom, right margins in mm
      filename:     `Karnataka_Police_Chat_Report_${new Date().toISOString().slice(0, 10)}.pdf`,
      image:        { type: "jpeg", quality: 0.98 },
      html2canvas:  { scale: 2, useCORS: true, logging: false },
      jsPDF:        { unit: "mm", format: "a4", orientation: "portrait" }
    };

    try {
      const { default: html2pdf } = await import("html2pdf.js");
      const exporter = typeof html2pdf === "function" ? html2pdf : (html2pdf as any).default;
      await exporter().from(element).set(opt).save();
    } catch (err) {
      console.error("PDF Export Execution Failed:", err);
    }
  };

  const send = async (text?: string) => {
    const trimmed = (text ?? input).trim();
    if (!trimmed || isChatBusy) return;

    setChatHistory((messages) => [
      ...messages,
      { id: crypto.randomUUID(), role: "user", content: trimmed, ts: Date.now() },
    ]);
    setInput("");
    setIsChatBusy(true);

    try {
      const reply = await askCopilot({
        question: trimmed,
        language: language === "kn" ? "kn" : "en",
      });
      setChatHistory((messages) => [
        ...messages,
        { id: crypto.randomUUID(), role: "assistant", content: reply, ts: Date.now() },
      ]);
    } catch (err) {
      console.error(err);
      const errorMsg = tr(
        "Sorry, I couldn't process that request. Please try again.",
        "ಕ್ಷಮಿಸಿ, ಆ ವಿನಂತಿಯನ್ನು ಪ್ರಕ್ರಿಯೆಗೊಳಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ."
      );
      setChatHistory((messages) => [
        ...messages,
        { id: crypto.randomUUID(), role: "assistant", content: errorMsg, ts: Date.now() },
      ]);
    } finally {
      setIsChatBusy(false);
    }
  };

  const tod = timeOfDay();
  const firstName = (user?.name ?? "Officer").split(/\s+/)[0];
  const greeting = language === "kn"
    ? (tod === "morning" ? "ಶುಭೋದಯ, ಅಧಿಕಾರಿಯವರೇ." : tod === "afternoon" ? "ಶುಭ ಮಧ್ಯಾಹ್ನ, ಅಧಿಕಾರಿಯವರೇ." : "ಶುಭ ಸಂಜೆ, ಅಧಿಕಾರಿಯವರೇ.")
    : (tod === "morning" ? `Good morning, ${firstName}.` : tod === "afternoon" ? `Good afternoon, ${firstName}.` : `Good evening, ${firstName}.`);

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink text-white">
      <div className="flex items-center gap-3 border-b border-line bg-ink px-3 py-3 sm:px-6">
        <div className="flex items-center gap-2 text-sm">
          <KSPPBrandMark size="sm" decorative />
          <span className="text-white font-medium">{tr("KSPP Assistant", "KSPP ಸಹಾಯಕ")}</span>
        </div>
        <div className="flex-1" />
        <button onClick={() => { setChatHistory([]); setIsChatBusy(false); }} className="min-h-9 rounded-md border border-brand/30 bg-brand/15 px-3 py-1.5 text-xs text-white transition hover:bg-brand/25">
          {tr("New session", "ಹೊಸ ಸೆಷನ್")}
        </button>
      </div>

      {chatHistory.length === 0 ? (
        <EmptyCanvas greeting={greeting} help={tr("How can I help you today?", "ಇಂದು ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?")} />
      ) : (
        <MessageList ref={chatListRef} messages={chatHistory} busy={isChatBusy} tr={tr} />
      )}
      <div ref={endRef} />

      <div className="shrink-0 px-3 pb-4 pt-3 sm:px-6 sm:pb-7 sm:pt-4">
        <div className="max-w-3xl mx-auto">
          <Composer
            value={input}
            onChange={setInput}
            onSend={() => send()}
            onVoiceResult={(text) => send(text)}
            onNavigateToFir={() => navigate("/fir/new")}
            onExportPdf={exportChatToPDF}
            busy={isChatBusy}
            tr={tr}
            language={language === "kn" ? "kn" : "en"}
            hasMessages={chatHistory.length > 0}
          />

          <p className="text-[11px] text-muted text-center mt-2">
            {tr(
              "Copilot generates drafts and queries — verify against source records before any official action.",
              "ಕೋಪೈಲಟ್ ಕರಡುಗಳು ಮತ್ತು ಪ್ರಶ್ನೆಗಳನ್ನು ರಚಿಸುತ್ತದೆ — ಯಾವುದೇ ಅಧಿಕೃತ ಕ್ರಮಕ್ಕೂ ಮೊದಲು ಮೂಲ ದಾಖಲೆಗಳೊಂದಿಗೆ ಪರಿಶೀಲಿಸಿ."
            )}
          </p>
        </div>
      </div>
    </div>
  );
};

const EmptyCanvas: React.FC<{ greeting: string; help: string }> = ({ greeting, help }) => (
  <div className="flex-1 flex items-center justify-center dotted-bg">
    <div className="px-4 text-center sm:px-6">
      <KSPPBrandMark size="lg" className="mb-4" decorative />
      <h1 className="font-schibsted text-2xl font-semibold text-white sm:text-3xl md:text-4xl">{greeting}</h1>
      <p className="text-muted text-sm mt-2 max-w-md mx-auto">{help}</p>
    </div>
  </div>
);

const MessageList = React.forwardRef<HTMLDivElement, { messages: Msg[]; busy: boolean; tr: (en: string, kn: string) => string }>(
  ({ messages, busy, tr }, ref) => (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto bg-ink px-3 py-5 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-3xl space-y-5 sm:space-y-6">
        {/* PDF Document Header (Renders inside exported PDF) */}
        <div className="hidden print:block pb-4 mb-6 border-b border-line text-white">
          <h1 className="text-xl font-bold">{tr("KSPP Assistant", "KSPP ಸಹಾಯಕ")}</h1>
          <p className="text-xs text-muted">{tr("Official Chat Conversation Transcript", "ಅಧಿಕೃತ ಸಂಭಾಷಣೆ ಪ್ರತಿ")}</p>
          <p className="text-[10px] text-muted mt-1">{tr("Generated on:", "ರಚಿಸಿದ ದಿನಾಂಕ:")} {new Date().toLocaleString()}</p>
        </div>

        {messages.map((m) => <Bubble key={m.id} msg={m} />)}
        {busy && <TypingBubble />}
      </div>
    </div>
  )
);
MessageList.displayName = "MessageList";

const Bubble: React.FC<{ msg: Msg }> = ({ msg }) => {
  const isUser = msg.role === "user";
  return (
    <div className={`flex items-start gap-3 ${isUser ? "justify-end" : ""}`}>
      {!isUser && <div className="h-8 w-8 rounded-full bg-brand grid place-items-center text-white text-xs font-semibold shrink-0">AI</div>}
      <div className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap sm:max-w-[80%] sm:px-4 sm:py-3 ${isUser ? "bg-brand text-white" : "bg-shell text-white border border-line"}`}>
        <Formatted text={msg.content} />
      </div>
      {isUser && <div className="h-8 w-8 rounded-full bg-panel border border-line grid place-items-center text-xs text-muted shrink-0">U</div>}
    </div>
  );
};

const TypingBubble = () => (
  <div className="flex items-start gap-3">
    <div className="h-8 w-8 rounded-full bg-brand grid place-items-center text-white text-xs font-semibold">AI</div>
    <div className="bg-shell border border-line rounded-2xl px-4 py-3 flex gap-1.5">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  </div>
);

const Formatted: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
      /^\*\*[^*]+\*\*$/.test(p) ? <strong key={i} className="text-white font-semibold">{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>
    )}
  </>
);

const Composer: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onVoiceResult: (text: string) => void;
  onNavigateToFir: () => void;
  onExportPdf: () => void;
  busy: boolean;
  tr: (en: string, kn: string) => string;
  language: "en" | "kn";
  hasMessages: boolean;
}> = ({ value, onChange, onSend, onVoiceResult, onNavigateToFir, onExportPdf, busy, tr, language, hasMessages }) => {
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(180, ta.scrollHeight) + "px";
  }, [value]);

  return (
    <div className="rounded-2xl border border-line bg-shell px-3 py-2.5 shadow-soft focus-within:border-brand/50 focus-within:ring-2 focus-within:ring-brand/15 sm:px-4 sm:py-3">
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
        placeholder={tr(
          "Ask the Copilot — try 'FIRs in Whitefield last week' or 'disposal rate'",
          "ಕೋಪೈಲಟ್ ಅನ್ನು ಕೇಳಿ — 'ಕಳೆದ ವಾರ ವೈಟ್‌ಫೀಲ್ಡ್‌ನ ಎಫ್‌ಐಆರ್‌ಗಳು' ಅಥವಾ 'ವಿಲೇವಾರಿ ದರ' ಎಂದು ಪ್ರಯತ್ನಿಸಿ"
        )}
        rows={1}
        className="w-full bg-transparent text-white placeholder-muted outline-none resize-none text-sm leading-relaxed"
      />
      <div className="flex items-center gap-1 mt-1">
        <button 
          hidden
          onClick={() => undefined}
          className="h-8 w-8 grid place-items-center rounded-md text-muted hover:text-white hover:bg-panel transition" 
          title={tr("Attach a file or picture", "ಫೈಲ್ ಅಥವಾ ಚಿತ್ರವನ್ನು ಲಗತ್ತಿಸಿ")}
        >
          ＋
        </button>
        
        <VoiceButton language={language} onResult={(text) => onVoiceResult(text)} />
        
        {/* Dynamic New FIR Page Shortcut Redirector */}
        <button 
          onClick={onNavigateToFir} 
          className="h-8 w-8 grid place-items-center rounded-md text-muted hover:text-white hover:bg-panel font-medium text-xs transition" 
          title={tr("New FIR Wizard", "ಹೊಸ ಎಫ್‌ಐಆರ್")}
        >
          <strong>FIR</strong>
        </button>

        {/* 🚀 EXPORT PDF BUTTON */}
        <button
          type="button"
          onClick={onExportPdf}
          disabled={!hasMessages}
          className="h-8 px-2 grid place-items-center rounded-md text-muted hover:text-white hover:bg-panel font-medium text-xs transition whitespace-nowrap" 
          title={tr("Generate PDF from chat history", "ಸಂಭಾಷಣೆಯಿಂದ PDF ರಚಿಸಿ")}
        >
          <strong>{tr("Generate PDF", "PDF ರಚಿಸಿ")}</strong>
        </button>

        <div className="flex-1" />
        <button onClick={onSend} disabled={busy || !value.trim()} className="h-8 w-8 grid place-items-center rounded-full bg-brand text-white disabled:opacity-40 hover:bg-brand/90 transition">↗</button>
      </div>
    </div>
  );
};


