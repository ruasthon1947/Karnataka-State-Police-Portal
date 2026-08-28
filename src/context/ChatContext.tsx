import React, { createContext, useContext, useEffect, useState } from "react";
import { ChatMessage, FirestoreChatSession, saveChatToFirebase } from "../lib/chatApi";
import { useAuth } from "./AuthContext";

interface ChatContextType {
  messages: ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  chatHistoryList: FirestoreChatSession[];
  setChatHistoryList: React.Dispatch<React.SetStateAction<FirestoreChatSession[]>>;
  startNewSession: () => void;
}

const ACTIVE_SESSION_STORAGE_KEY = "kspp_active_session";
const ARCHIVED_SESSIONS_STORAGE_KEY = "kspp_archived_sessions";

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const userId = user?.employeeId || "";

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [chatHistoryList, setChatHistoryList] = useState<FirestoreChatSession[]>(() => {
    try {
      const cached = localStorage.getItem(ARCHIVED_SESSIONS_STORAGE_KEY);
      if (!cached) return [];
      const parsed: FirestoreChatSession[] = JSON.parse(cached);
      // Deduplicate on initial load
      return Array.from(new Map(parsed.map((s) => [s.id, s])).values());
    } catch {
      return [];
    }
  });

  // Synchronize active messages to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(messages));
    } catch (err) {
      console.error("Failed to sync active chat session to localStorage:", err);
    }
  }, [messages]);

  // Synchronize archived sessions to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(ARCHIVED_SESSIONS_STORAGE_KEY, JSON.stringify(chatHistoryList));
    } catch (err) {
      console.error("Failed to sync archived sessions to localStorage:", err);
    }
  }, [chatHistoryList]);

  const addMessage = (message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  };

  const startNewSession = () => {
    // Prevent saving empty sessions
    if (!messages || messages.length === 0) return;

    const firstUserMsg = messages.find((m) => m.role === "user")?.content || "New Conversation";
    const title = firstUserMsg.length > 25 ? `${firstUserMsg.slice(0, 25)}...` : firstUserMsg;

    const sessionId = crypto.randomUUID();
    const archivedSession: FirestoreChatSession = {
      id: sessionId,
      title,
      timestamp: Date.now(),
      messages: [...messages],
    };

    if (userId) {
      saveChatToFirebase(userId, archivedSession);
    }

    setChatHistoryList((prev) => {
      // Prevent duplicate insertions
      if (prev.some((s) => s.id === sessionId)) return prev;
      return [archivedSession, ...prev];
    });

    setMessages([]);
    localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  };

  return (
    <ChatContext.Provider
      value={{
        messages,
        addMessage,
        setMessages,
        chatHistoryList,
        setChatHistoryList,
        startNewSession,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChat must be used within a ChatProvider");
  }
  return context;
};

export default ChatProvider;