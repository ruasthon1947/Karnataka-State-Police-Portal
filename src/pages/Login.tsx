import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import {
  KSPPBrandMark,
  KARNATAKA_GOVERNMENT,
  KARNATAKA_GOVERNMENT_KANNADA,
  KSPP_KANNADA_NAME,
  KSPP_NAME,
  KSPP_SHORT_NAME,
  KSPP_TAGLINE,
} from "../components/brand/KSPPBrand";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";

const Login: React.FC = () => {
  const { user, isLoading, login, theme, toggleTheme } = useAuth();
  const { language, setLanguage, tr } = useLanguage();
  const navigate = useNavigate();
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isLoading && user) {
      navigate("/", { replace: true });
    }
  }, [isLoading, navigate, user]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");

    const result = await login(id, password);
    setLoading(false);

    if (!result.ok) {
      setError(
        !id
          ? tr("Employee ID is required.", "ಉದ್ಯೋಗಿ ಐಡಿ ಅಗತ್ಯವಿದೆ.")
          : !password
            ? tr("Password is required.", "ಪಾಸ್‌ವರ್ಡ್ ಅಗತ್ಯವಿದೆ.")
            : result.error ||
              tr(
                "Invalid credentials. Try again.",
                "ತಪ್ಪಾದ ಲಾಗಿನ್ ವಿವರಗಳು. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
              ),
      );
      return;
    }
    // The useEffect above will handle the navigation and digest check
    // once the user context updates.
  };

  return (
    <div className="min-h-[100dvh] overflow-x-hidden bg-ink text-white">
      <div className="gov-tricolor" aria-hidden="true" />

      <header className="border-b border-white/10 bg-gov-navy text-white">
        <div className="mx-auto flex min-h-12 max-w-7xl items-center justify-between gap-2 px-3 py-2 sm:gap-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 text-[11px] font-medium text-white/75 sm:text-xs">
            <span className="gov-emblem-dot" aria-hidden="true">
              ಕ
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate font-semibold text-white">
                {KARNATAKA_GOVERNMENT_KANNADA}
              </span>
              <span className="hidden text-[9px] uppercase tracking-wide text-white/60 sm:block">
                {KARNATAKA_GOVERNMENT}
              </span>
            </span>
            <span className="hidden text-white/25 sm:inline" aria-hidden="true">
              |
            </span>
            <span className="hidden leading-tight md:block">
              <span className="block font-semibold text-white">ಪೊಲೀಸ್ ಇಲಾಖೆ</span>
              <span className="block text-[9px] uppercase tracking-wide text-white/60">
                {tr("Department of Police", "ಪೊಲೀಸ್ ಇಲಾಖೆ")}
              </span>
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <label className="sr-only" htmlFor="login-language">
              {tr("Language", "ಭಾಷೆ")}
            </label>
            <select
              id="login-language"
              value={language}
              onChange={(event) => setLanguage(event.target.value as "en" | "kn")}
              className="gov-utility-control h-9 rounded-lg border border-white/20 bg-white/10 px-2.5 text-xs outline-none focus:border-gov-gold"
            >
              <option value="en">{tr("English", "ಇಂಗ್ಲಿಷ್")}</option>
              <option value="kn">ಕನ್ನಡ</option>
            </select>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={tr("Toggle colour theme", "ಬಣ್ಣದ ಥೀಮ್ ಬದಲಾಯಿಸಿ")}
              className="gov-utility-control h-9 rounded-lg border border-white/20 bg-white/10 px-3 text-xs font-medium transition hover:border-gov-gold/60"
            >
              <span aria-hidden="true">◐</span>{" "}
              <span className="hidden sm:inline">
                {theme === "light" ? tr("Dark", "ಡಾರ್ಕ್") : tr("Light", "ಲೈಟ್")}
              </span>
            </button>
          </div>
        </div>
      </header>

      <main className="gov-login-bg flex min-h-[calc(100dvh-9.5rem)] items-start px-3 py-4 sm:items-center sm:px-6 sm:py-6 lg:py-12">
        <div className="mx-auto grid w-full max-w-5xl overflow-hidden rounded-xl border border-line bg-shell shadow-gov sm:rounded-2xl lg:grid-cols-[1.05fr_.95fr]">
          <section className="relative hidden overflow-hidden bg-gov-navy p-10 text-white lg:flex lg:flex-col lg:justify-between">
            <div className="gov-panel-pattern" aria-hidden="true" />
            <div className="relative">
              <div className="mb-8 inline-flex rounded-full bg-white p-1.5 shadow-xl">
                <KSPPBrandMark size="xl" />
              </div>
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-gov-gold">
                {tr("Official Police Information System", "ಅಧಿಕೃತ ಪೊಲೀಸ್ ಮಾಹಿತಿ ವ್ಯವಸ್ಥೆ")}
              </div>
              <h1 className="mt-4 max-w-md text-4xl font-semibold leading-tight tracking-tight text-white">
                {KSPP_NAME}
              </h1>
              <p className="mt-2 text-lg font-semibold text-white/90">{KSPP_KANNADA_NAME}</p>
              <p className="mt-3 text-sm font-medium text-white/70">{KSPP_TAGLINE}</p>
            </div>

            <div className="relative rounded-xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm">
              <div className="flex items-start gap-3">
                <span
                  className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gov-gold/20 text-gov-gold"
                  aria-hidden="true"
                >
                  ✓
                </span>
                <div>
                  <div className="text-sm font-semibold text-white">
                    {tr("Authorised access only", "ಅಧಿಕೃತ ಪ್ರವೇಶ ಮಾತ್ರ")}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-white/70">
                    {tr(
                      "This secure portal is intended for authorised Karnataka State Police personnel.",
                      "ಈ ಸುರಕ್ಷಿತ ಪೋರ್ಟಲ್ ಅಧಿಕೃತ ಕರ್ನಾಟಕ ರಾಜ್ಯ ಪೊಲೀಸ್ ಸಿಬ್ಬಂದಿಗಾಗಿ ಮಾತ್ರ.",
                    )}
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section className="p-4 min-[380px]:p-5 sm:p-8 lg:p-10">
            <div className="mb-6 flex items-start gap-3 sm:mb-7 lg:hidden">
              <KSPPBrandMark size="lg" className="mt-0.5" />
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">
                  {KSPP_SHORT_NAME}
                </div>
                <div className="text-sm font-semibold leading-tight sm:text-base">{KSPP_NAME}</div>
                <div className="mt-1 text-[10px] font-medium leading-tight text-brand sm:text-[11px]">
                  {KSPP_KANNADA_NAME}
                </div>
                <div className="mt-0.5 text-[9px] text-muted">{KSPP_TAGLINE}</div>
              </div>
            </div>

            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-sage/25 bg-sage/10 px-3 py-1 text-[11px] font-semibold text-sage">
                <span className="h-1.5 w-1.5 rounded-full bg-sage" aria-hidden="true" />
                {tr("Secure employee sign-in", "ಸುರಕ್ಷಿತ ಉದ್ಯೋಗಿ ಲಾಗಿನ್")}
              </div>
              <h2 className="mt-4 text-2xl font-semibold tracking-tight">
                {tr("Welcome to KSPP", "KSPP ಗೆ ಸ್ವಾಗತ")}
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                {tr(
                  "Use your Karnataka State Police Employee ID and password to continue.",
                  "ಮುಂದುವರಿಯಲು ನಿಮ್ಮ ಕರ್ನಾಟಕ ರಾಜ್ಯ ಪೊಲೀಸ್ ಉದ್ಯೋಗಿ ಐಡಿ ಮತ್ತು ಪಾಸ್‌ವರ್ಡ್ ಬಳಸಿ.",
                )}
              </p>
            </div>

            <form onSubmit={submit} className="mt-6 sm:mt-7" noValidate>
              <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
                {tr("Employee ID", "ಉದ್ಯೋಗಿ ಐಡಿ")}
                <input
                  value={id}
                  onChange={(event) => setId(event.target.value)}
                  placeholder={tr("e.g. KA-SI-10427", "ಉದಾ. KA-SI-10427")}
                  autoComplete="username"
                  inputMode="text"
                  className="mt-2 h-11 w-full rounded-lg border border-line bg-panel px-3.5 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15"
                />
              </label>

              <label className="mt-5 block text-xs font-semibold uppercase tracking-wide text-muted">
                {tr("Password", "ಪಾಸ್‌ವರ್ಡ್")}
                <div className="relative mt-2">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={tr("Enter your password", "ನಿಮ್ಮ ಪಾಸ್‌ವರ್ಡ್ ನಮೂದಿಸಿ")}
                    autoComplete="current-password"
                    className="h-11 w-full rounded-lg border border-line bg-panel pl-3.5 pr-10 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={
                      showPassword
                        ? tr("Hide password", "ಪಾಸ್‌ವರ್ಡ್ ಮರೆಮಾಚಿ")
                        : tr("Show password", "ಪಾಸ್‌ವರ್ಡ್ ತೋರಿಸಿ")
                    }
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-white transition focus:outline-none"
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </label>

              {error && (
                <div
                  role="alert"
                  aria-live="polite"
                  className="mt-4 rounded-lg border border-rose/30 bg-rose/10 p-3 text-sm text-rose"
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-brand/90 disabled:cursor-wait disabled:opacity-60"
              >
                {loading && <span className="button-spinner" aria-hidden="true" />}
                {loading
                  ? tr("Signing in securely...", "ಸುರಕ್ಷಿತವಾಗಿ ಲಾಗಿನ್ ಆಗುತ್ತಿದೆ...")
                  : tr("Sign in to KSPP", "KSPP ಗೆ ಲಾಗಿನ್ ಮಾಡಿ")}
              </button>

              <div className="mt-6 rounded-xl border border-line bg-panel/70 p-4 text-xs text-muted">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1 font-semibold text-white">
                    {tr("Access assistance", "ಪ್ರವೇಶ ಸಹಾಯ")}
                  </div>
                  <span className="shrink-0 rounded bg-amber/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber">
                    {tr("Help", "ಸಹಾಯ")}
                  </span>
                </div>
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  <div>
                    {tr("First-time user", "ಮೊದಲ ಬಾರಿಗೆ ಬಳಕೆದಾರ")} →{" "}
                    <span>{tr("use the temporary password issued by your administrator", "ನಿರ್ವಾಹಕರು ನೀಡಿದ ತಾತ್ಕಾಲಿಕ ಪಾಸ್‌ವರ್ಡ್ ಬಳಸಿ")}</span>
                  </div>
                  <div>
                    {tr("Returning user", "ಮರುಬಳಕೆದಾರ")} →{" "}
                    <span>{tr("use your current password", "ನಿಮ್ಮ ಪ್ರಸ್ತುತ ಪಾಸ್‌ವರ್ಡ್ ಬಳಸಿ")}</span>
                  </div>
                </div>
              </div>
            </form>
          </section>
        </div>
      </main>

      <footer className="border-t border-line bg-shell px-3 py-4 text-center text-[11px] text-muted sm:px-4">
        <div className="font-medium text-white">
          © ಕರ್ನಾಟಕ ಸರ್ಕಾರ · ಕರ್ನಾಟಕ ರಾಜ್ಯ ಪೊಲೀಸ್
        </div>
        <div className="mt-0.5">
          {tr("Government of Karnataka · Karnataka State Police", "ಕರ್ನಾಟಕ ಸರ್ಕಾರ · ಕರ್ನಾಟಕ ರಾಜ್ಯ ಪೊಲೀಸ್")}
        </div>
        <div className="mt-1">
          {tr(
            "Official use only · All access is subject to monitoring",
            "ಅಧಿಕೃತ ಬಳಕೆಗೆ ಮಾತ್ರ · ಎಲ್ಲಾ ಪ್ರವೇಶ ಮೇಲ್ವಿಚಾರಣೆಗೆ ಒಳಪಟ್ಟಿರುತ್ತದೆ",
          )}
        </div>
      </footer>
    </div>
  );
};

export default Login;