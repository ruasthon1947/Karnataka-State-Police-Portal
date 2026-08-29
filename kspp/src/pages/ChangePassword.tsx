import React, { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { useNavigate } from "react-router-dom";
import { KSPPBrandMark, KSPP_SHORT_NAME } from "../components/brand/KSPPBrand";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import { auth } from "../firebase";

const ChangePassword: React.FC = () => {
  const { user, changePassword, logout, theme, toggleTheme } = useAuth();
  const { language, setLanguage, tr } = useLanguage();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    const isCompletingFirstLogin = user?.isFirstLogin === true;

    if (!current) {
      setError(tr("Enter your current password.", "ನಿಮ್ಮ ಪ್ರಸ್ತುತ ಪಾಸ್‌ವರ್ಡ್ ನಮೂದಿಸಿ."));
      return;
    }
    if (next.length < 8) {
      setError(
        tr(
          "New password must be at least 8 characters.",
          "ಹೊಸ ಪಾಸ್‌ವರ್ಡ್ ಕನಿಷ್ಠ 8 ಅಕ್ಷರಗಳಿರಬೇಕು.",
        ),
      );
      return;
    }
    if (!/[A-Za-z]/.test(next) || !/\d/.test(next)) {
      setError(
        tr(
          "New password must contain at least one letter and one number.",
          "ಹೊಸ ಪಾಸ್‌ವರ್ಡ್‌ನಲ್ಲಿ ಕನಿಷ್ಠ ಒಂದು ಅಕ್ಷರ ಮತ್ತು ಒಂದು ಸಂಖ್ಯೆ ಇರಬೇಕು.",
        ),
      );
      return;
    }
    if (next === current) {
      setError(
        tr(
          "New password must differ from the current password.",
          "ಹೊಸ ಪಾಸ್‌ವರ್ಡ್ ಪ್ರಸ್ತುತ ಪಾಸ್‌ವರ್ಡ್‌ಗಿಂತ ಭಿನ್ನವಾಗಿರಬೇಕು.",
        ),
      );
      return;
    }
    if (next !== confirm) {
      setError(
        tr(
          "New password and confirmation do not match.",
          "ಹೊಸ ಪಾಸ್‌ವರ್ಡ್ ಮತ್ತು ದೃಢೀಕರಣ ಹೊಂದಿಕೆಯಾಗುತ್ತಿಲ್ಲ.",
        ),
      );
      return;
    }

    setSubmitting(true);
    try {
      let firebaseIdToken = "";
      try {
        const credential = await signInWithEmailAndPassword(
          auth,
          `${user?.employeeId}@ksph.gov.in`.toLowerCase(),
          current,
        );
        firebaseIdToken = await credential.user.getIdToken();
      } catch {
        // The server also verifies temporary and migrated application passwords.
      }

      const result = await changePassword(current, next, firebaseIdToken);
      if (!result.ok) {
        setError(
          result.error ||
            tr("Password could not be updated.", "ಪಾಸ್‌ವರ್ಡ್ ನವೀಕರಿಸಲಾಗಲಿಲ್ಲ."),
        );
        return;
      }
      navigate(
        "/",
        isCompletingFirstLogin
          ? { replace: true, state: { showDigest: true } }
          : { replace: true },
      );
    } finally {
      setSubmitting(false);
    }
  };

  const leave = () => {
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <main className="relative grid min-h-[100dvh] place-items-center overflow-x-hidden bg-ink px-3 py-6 text-white sm:px-6">
      <div className="gov-tricolor absolute inset-x-0 top-0" aria-hidden="true" />
      <div className="dotted-bg pointer-events-none absolute inset-0" aria-hidden="true" />

      <section className="relative z-10 w-full max-w-md">
        <header className="mb-5 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <KSPPBrandMark size="md" />
            <div className="min-w-0">
              <h1 className="text-lg font-semibold">
                {tr("Set a new password", "ಹೊಸ ಪಾಸ್‌ವರ್ಡ್ ಹೊಂದಿಸಿ")}
              </h1>
              <p className="truncate text-xs text-muted">
                {KSPP_SHORT_NAME} · {user?.name} ({user?.employeeId})
              </p>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <label className="sr-only" htmlFor="password-language">
              {tr("Language", "ಭಾಷೆ")}
            </label>
            <select
              id="password-language"
              value={language}
              onChange={(event) => setLanguage(event.target.value as "en" | "kn")}
              className="h-10 rounded-lg border border-line bg-shell px-2 text-sm"
            >
              <option value="en">{tr("English", "ಇಂಗ್ಲಿಷ್")}</option>
              <option value="kn">ಕನ್ನಡ</option>
            </select>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={tr("Toggle theme", "ಥೀಮ್ ಬದಲಿಸಿ")}
              className="h-10 rounded-lg border border-line bg-shell px-3 text-sm"
            >
              {theme === "dark" ? tr("Light", "ಲೈಟ್") : tr("Dark", "ಡಾರ್ಕ್")}
            </button>
          </div>
        </header>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-2xl border border-line bg-shell p-5 shadow-soft sm:p-7"
          noValidate
        >
          <p className="text-sm leading-6 text-muted">
            {tr(
              "Use at least 8 characters with a letter and a number. Your temporary password will stop working immediately.",
              "ಕನಿಷ್ಠ 8 ಅಕ್ಷರಗಳು, ಒಂದು ಅಕ್ಷರ ಮತ್ತು ಒಂದು ಸಂಖ್ಯೆಯನ್ನು ಬಳಸಿ. ನಿಮ್ಮ ತಾತ್ಕಾಲಿಕ ಪಾಸ್‌ವರ್ಡ್ ತಕ್ಷಣವೇ ಕೆಲಸ ಮಾಡುವುದನ್ನು ನಿಲ್ಲಿಸುತ್ತದೆ.",
            )}
          </p>

          <PasswordField
            label={tr("Current password", "ಪ್ರಸ್ತುತ ಪಾಸ್‌ವರ್ಡ್")}
            value={current}
            onChange={setCurrent}
            type={showPasswords ? "text" : "password"}
            autoComplete="current-password"
          />
          <PasswordField
            label={tr("New password", "ಹೊಸ ಪಾಸ್‌ವರ್ಡ್")}
            value={next}
            onChange={setNext}
            type={showPasswords ? "text" : "password"}
            autoComplete="new-password"
          />
          <PasswordField
            label={tr("Confirm new password", "ಹೊಸ ಪಾಸ್‌ವರ್ಡ್ ದೃಢೀಕರಿಸಿ")}
            value={confirm}
            onChange={setConfirm}
            type={showPasswords ? "text" : "password"}
            autoComplete="new-password"
          />

          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={showPasswords}
              onChange={(event) => setShowPasswords(event.target.checked)}
              className="accent-brand"
            />
            {tr("Show passwords", "ಪಾಸ್‌ವರ್ಡ್‌ಗಳನ್ನು ತೋರಿಸಿ")}
          </label>

          <PasswordHints password={next} />

          {error && (
            <div
              role="alert"
              aria-live="polite"
              className="rounded-lg border border-rose/30 bg-rose/10 px-3 py-2 text-sm text-rose"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-brand py-2.5 font-medium text-white transition hover:bg-brand/90 disabled:cursor-wait disabled:opacity-60"
          >
            {submitting
              ? tr("Updating…", "ನವೀಕರಿಸಲಾಗುತ್ತಿದೆ…")
              : tr("Update password and continue", "ಪಾಸ್‌ವರ್ಡ್ ನವೀಕರಿಸಿ ಮುಂದುವರಿಸಿ")}
          </button>
          <button
            type="button"
            onClick={leave}
            disabled={submitting}
            className="w-full rounded-lg border border-line bg-transparent py-2.5 font-medium text-muted transition hover:bg-line/50"
          >
            {tr("Back to login", "ಲಾಗಿನ್‌ಗೆ ಹಿಂತಿರುಗಿ")}
          </button>
        </form>
      </section>
    </main>
  );
};

const PasswordField: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  type: "text" | "password";
  autoComplete: string;
}> = ({ label, value, onChange, type, autoComplete }) => (
  <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
    {label}
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      type={type}
      autoComplete={autoComplete}
      className="focus-ring mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2.5 text-sm text-white outline-none"
    />
  </label>
);

const PasswordHints: React.FC<{ password: string }> = ({ password }) => {
  const { tr } = useLanguage();
  const checks = [
    {
      ok: password.length >= 8,
      label: tr("At least 8 characters", "ಕನಿಷ್ಠ 8 ಅಕ್ಷರಗಳು"),
    },
    {
      ok: /[A-Za-z]/.test(password),
      label: tr("Contains a letter", "ಒಂದು ಅಕ್ಷರ ಒಳಗೊಂಡಿದೆ"),
    },
    {
      ok: /\d/.test(password),
      label: tr("Contains a number", "ಒಂದು ಸಂಖ್ಯೆ ಒಳಗೊಂಡಿದೆ"),
    },
  ];

  return (
    <ul className="space-y-1 text-xs text-muted" aria-label={tr("Password requirements", "ಪಾಸ್‌ವರ್ಡ್ ಅಗತ್ಯತೆಗಳು")}>
      {checks.map((check) => (
        <li key={check.label} className="flex items-center gap-2">
          <span className={check.ok ? "text-sage" : "text-muted"} aria-hidden="true">
            {check.ok ? "✓" : "•"}
          </span>
          {check.label}
        </li>
      ))}
    </ul>
  );
};

export default ChangePassword;




