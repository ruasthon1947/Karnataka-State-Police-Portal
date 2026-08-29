import React, {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Language = "en" | "kn";

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  tr: (english: string, kannada: string) => string;
};
const LanguageContext = createContext<LanguageContextValue | null>(null);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [language, setLanguageState] = useState<Language>(() =>
    localStorage.getItem("kpfir.language") === "kn" ? "kn" : "en",
  );

  const setLanguage = useCallback((nextLanguage: Language) => {
    setLanguageState(nextLanguage);
    localStorage.setItem("kpfir.language", nextLanguage);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === "kn" ? "kn" : "en";
    document.documentElement.dataset.language = language;
    localStorage.setItem("kpfir.language", language);
  }, [language]);

  useEffect(() => {
    const syncLanguage = (event: StorageEvent) => {
      if (event.key !== "kpfir.language") return;
      setLanguageState(event.newValue === "kn" ? "kn" : "en");
    };
    window.addEventListener("storage", syncLanguage);
    return () => window.removeEventListener("storage", syncLanguage);
  }, []);

  const value = useMemo(
    () => ({
      language,
      setLanguage,
      tr: (english: string, kannada: string) =>
        language === "kn" ? kannada : english,
    }),
    [language, setLanguage],
  );

  return (
    <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
  );
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used inside LanguageProvider");
  }
  return context;
};
