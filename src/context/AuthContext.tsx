import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type AuthUser = {
  employeeId: string;
  name: string;
  role: "Constable" | "Inspector" | "SP";
  policeStation: string;
  isFirstLogin: boolean;
};

type Theme = "dark" | "light";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
};

type OperationResult = { ok: boolean; error?: string };

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  login: (employeeId: string, password: string) => Promise<OperationResult>;
  changePassword: (
    currentPassword: string,
    newPassword: string,
    firebaseIdToken?: string,
  ) => Promise<OperationResult>;
  logout: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  sessionExpiresAt: number | null;
  extendSession: () => Promise<OperationResult>;
  lastLogin: string | null;
  chatHistory: ChatMessage[];
  setChatHistory: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  isChatBusy: boolean;
  setIsChatBusy: React.Dispatch<React.SetStateAction<boolean>>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const LS_THEME = "kpfir.theme";
const LS_LAST_LOGIN = "kpfir.lastLogin";

async function responseData(response: Response) {
  return response.json().catch(() => null);
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastLogin, setLastLogin] = useState<string | null>(() =>
    localStorage.getItem(LS_LAST_LOGIN),
  );
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(LS_THEME);
    return stored === "dark" ? "dark" : "light";
  });
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isChatBusy, setIsChatBusy] = useState(false);

  const clearLocalSession = useCallback(() => {
    setUser(null);
    setSessionExpiresAt(null);
    setChatHistory([]);
    setIsChatBusy(false);
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/session", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        const data = await responseData(response);
        if (!active || !response.ok || !data?.ok) return;
        setUser(data.user as AuthUser);
        setSessionExpiresAt(Number(data.sessionExpiresAt) || null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(theme);
    localStorage.setItem(LS_THEME, theme);
  }, [theme]);

  const login = useCallback<AuthContextValue["login"]>(
    async (employeeId, password) => {
      const id = employeeId.trim();
      if (!id) return { ok: false, error: "Employee ID is required." };
      if (!password) return { ok: false, error: "Password is required." };

      let firebaseIdToken = "";
      try {
        const [{ auth }, { signInWithEmailAndPassword }] = await Promise.all([
          import("../firebase"),
          import("firebase/auth"),
        ]);
        const credential = await signInWithEmailAndPassword(
          auth,
          `${id}@ksph.gov.in`.toLowerCase(),
          password,
        );
        firebaseIdToken = await credential.user.getIdToken();
      } catch {
        // Temporary and migrated passwords are verified by the application server.
      }

      try {
        const response = await fetch("/api/login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ employeeId: id, password, firebaseIdToken }),
        });
        const data = await responseData(response);
        if (!response.ok || !data?.ok) {
          return {
            ok: false,
            error: data?.error || "Sign-in could not be completed.",
          };
        }

        setUser(data.user as AuthUser);
        setSessionExpiresAt(Number(data.sessionExpiresAt) || null);
        const now = new Date().toISOString();
        setLastLogin(now);
        localStorage.setItem(LS_LAST_LOGIN, now);
        return { ok: true };
      } catch {
        return {
          ok: false,
          error: "The sign-in service is unavailable. Please try again.",
        };
      }
    },
    [],
  );

  const changePassword = useCallback<AuthContextValue["changePassword"]>(
    async (currentPassword, newPassword, firebaseIdToken = "") => {
      try {
        const response = await fetch("/api/employee/password", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            currentPassword,
            newPassword,
            firebaseIdToken,
          }),
        });
        const data = await responseData(response);
        if (!response.ok || !data?.ok) {
          if (response.status === 401 && data?.error?.includes("session")) {
            clearLocalSession();
          }
          return {
            ok: false,
            error: data?.error || "Password could not be updated.",
          };
        }
        setUser(data.user as AuthUser);
        setSessionExpiresAt(Number(data.sessionExpiresAt) || null);
        return { ok: true };
      } catch {
        return {
          ok: false,
          error: "The password service is unavailable. Please try again.",
        };
      }
    },
    [clearLocalSession],
  );

  const logout = useCallback(() => {
    if (user?.employeeId) {
      const prefix = `kpfir.firDraft.${user.employeeId}.`;
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key?.startsWith(prefix)) sessionStorage.removeItem(key);
      }
    }
    clearLocalSession();
    void fetch("/api/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
  }, [clearLocalSession, user?.employeeId]);

  const extendSession = useCallback(async (): Promise<OperationResult> => {
    try {
      const response = await fetch("/api/session/extend", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await responseData(response);
      if (!response.ok || !data?.ok) {
        clearLocalSession();
        return { ok: false, error: data?.error || "Session expired." };
      }
      setUser(data.user as AuthUser);
      setSessionExpiresAt(Number(data.sessionExpiresAt) || null);
      return { ok: true };
    } catch {
      return { ok: false, error: "Session could not be extended." };
    }
  }, [clearLocalSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      login,
      changePassword,
      logout,
      theme,
      setTheme: setThemeState,
      toggleTheme: () =>
        setThemeState((current) => (current === "dark" ? "light" : "dark")),
      sessionExpiresAt,
      extendSession,
      lastLogin,
      chatHistory,
      setChatHistory,
      isChatBusy,
      setIsChatBusy,
    }),
    [
      user,
      isLoading,
      login,
      changePassword,
      logout,
      theme,
      sessionExpiresAt,
      extendSession,
      lastLogin,
      chatHistory,
      isChatBusy,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
};
