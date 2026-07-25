import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import "./index.css";
import { LanguageProvider } from "./context/LanguageContext";

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
