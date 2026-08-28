import React, { createContext, useContext, useEffect, useState } from "react";
import { ChatMessage, FirestoreChatSession, saveChatToFirebase } from "../lib/chatApi";
import { useAuth } from "./AuthContext";

interface ChatContextType {
  messages: ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  chatHistoryList: FirestoreChatSession[];
  setChatHistoryList: React.Dispatch<React.SetStateAction<FirestoreChatSession[]>>;
  currentSessionId: string | null;
  setCurrentSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  startNewSession: () => void;
}

const storageKey = (userId: string, kind: "active" | "recents") =>
  `kspp_chat_${kind}:${encodeURIComponent(userId)}`;

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const userId = user?.employeeId || "";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatHistoryList, setChatHistoryList] = useState<FirestoreChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [storageOwnerId, setStorageOwnerId] = useState("");
  const isOfficerCacheReady = Boolean(userId) && storageOwnerId === userId;

  // Hydrate only the signed-in officer's cache. Shared browser storage must
  // never expose one officer's recent queries to another officer.
  useEffect(() => {
    if (!userId) {
      setMessages([]);
      setChatHistoryList([]);
      setCurrentSessionId(null);
      setStorageOwnerId("");
      return;
    }

    try {
      const active = JSON.parse(localStorage.getItem(storageKey(userId, "active")) || "null");
      const recents = JSON.parse(localStorage.getItem(storageKey(userId, "recents")) || "[]");
      setMessages(Array.isArray(active?.messages) ? active.messages : []);
      setCurrentSessionId(typeof active?.sessionId === "string" ? active.sessionId : null);
      setChatHistoryList(
        Array.isArray(recents)
          ? Array.from(
              new Map(
                (recents as FirestoreChatSession[])
                  .filter((session) => session?.id && Array.isArray(session.messages))
                  .map((session) => [session.id, session]),
              ).values(),
            )
          : [],
      );
    } catch {
      setMessages([]);
      setChatHistoryList([]);
      setCurrentSessionId(null);
    }
    setStorageOwnerId(userId);
  }, [userId]);

  // Synchronize active messages to localStorage
  useEffect(() => {
    if (!userId || storageOwnerId !== userId) return;
    try {
      localStorage.setItem(
        storageKey(userId, "active"),
        JSON.stringify({ sessionId: currentSessionId, messages }),
      );
    } catch (err) {
      console.error("Failed to sync active chat session to localStorage:", err);
    }
  }, [currentSessionId, messages, storageOwnerId, userId]);

  // Synchronize archived sessions to localStorage
  useEffect(() => {
    if (!userId || storageOwnerId !== userId) return;
    try {
      localStorage.setItem(storageKey(userId, "recents"), JSON.stringify(chatHistoryList));
    } catch (err) {
      console.error("Failed to sync archived sessions to localStorage:", err);
    }
  }, [chatHistoryList, storageOwnerId, userId]);

  const addMessage = (message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  };

  const startNewSession = () => {
    if (messages.length > 0) {
      const firstUserMsg = messages.find((message) => message.role === "user")?.content;
      const sessionId = currentSessionId || crypto.randomUUID();
      const archivedSession: FirestoreChatSession = {
        id: sessionId,
        title: firstUserMsg?.slice(0, 30) || "New Conversation",
        timestamp: Date.now(),
        messages: [...messages],
      };

      if (userId) void saveChatToFirebase(userId, archivedSession);
      setChatHistoryList((previous) => [
        archivedSession,
        ...previous.filter((session) => session.id !== sessionId),
      ]);
    }

    setCurrentSessionId(null);
    setMessages([]);
  };

  return (
    <ChatContext.Provider
      value={{
        messages: isOfficerCacheReady ? messages : [],
        addMessage,
        setMessages,
        chatHistoryList: isOfficerCacheReady ? chatHistoryList : [],
        setChatHistoryList,
        currentSessionId: isOfficerCacheReady ? currentSessionId : null,
        setCurrentSessionId,
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
