import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import "./index.css";
import { LanguageProvider } from "./context/LanguageContext";

// Apply saved preferences before React paints so login and protected screens
// never flash or reset to a different theme/language during navigation.
const savedTheme = localStorage.getItem("kpfir.theme") === "dark" ? "dark" : "light";
const savedLanguage = localStorage.getItem("kpfir.language") === "kn" ? "kn" : "en";
document.documentElement.classList.remove("light", "dark");
document.documentElement.classList.add(savedTheme);
document.documentElement.lang = savedLanguage;
document.documentElement.dataset.language = savedLanguage;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <LanguageProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </LanguageProvider>
    </BrowserRouter>
  </React.StrictMode>
);

const bootScreen = document.getElementById("kspp-boot");
if (bootScreen) {
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      bootScreen.classList.add("is-ready");
      window.setTimeout(() => bootScreen.remove(), 450);
    }, 650);
  });
}
