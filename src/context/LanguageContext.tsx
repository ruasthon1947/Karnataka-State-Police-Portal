import React, {
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

  const setLanguage = (nextLanguage: Language) => {
    setLanguageState(nextLanguage);
    localStorage.setItem("kpfir.language", nextLanguage);
  };

  useEffect(() => {
    document.documentElement.lang = language === "kn" ? "kn" : "en";
  }, [language]);

  const value = useMemo(
    () => ({
      language,
      setLanguage,
      tr: (english: string, kannada: string) =>
        language === "kn" ? kannada : english,
    }),
    [language],
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
