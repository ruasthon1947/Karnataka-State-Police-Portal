import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Clock3, ShieldCheck } from "lucide-react";
import {
  KARNATAKA_GOVERNMENT,
  KARNATAKA_GOVERNMENT_KANNADA,
  KSPPBrandMark,
  KSPP_KANNADA_NAME,
  KSPP_NAME,
  KSPP_TAGLINE,
  KSPP_TAGLINE_KANNADA,
} from "../components/brand/KSPPBrand";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";

type Props = {
  title: string;
  description?: string;
};

const Stub: React.FC<Props> = ({ title, description }) => {
  const { user } = useAuth();
  const { tr } = useLanguage();
  return (
    <div className="space-y-5">
      <div className="relative text-center">
        <div>
          <h1 className="text-white font-schibsted text-2xl font-semibold">
            {title}
          </h1>
          {description && (
            <p className="text-muted text-sm mt-1">{description}</p>
          )}
        </div>
        <div className="mt-2 text-xs text-muted">
          {tr("Signed in as", "ಲಾಗಿನ್ ಆಗಿರುವವರು")}{" "}
          <span className="text-white">
            {user?.name} ({user?.employeeId})
          </span>
        </div>
      </div>

      <div className="bg-shell border border-line rounded-xl p-6 text-muted text-sm">
        {tr("Preview space - content for this screen lives in its page component.", "ಮುನ್ನೋಟ ಸ್ಥಳ - ಈ ಪರದೆಯ ವಿಷಯವು ಅದರ ಪುಟ ಘಟಕದಲ್ಲಿದೆ.")}
      </div>
    </div>
  );
};

export default Stub;

export const NotFound: React.FC = () => {
  const navigate = useNavigate();
  const { tr } = useLanguage();

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-ink px-4 text-white">
      <section className="w-full max-w-lg rounded-2xl border border-line bg-shell p-6 text-center shadow-soft sm:p-8">
        <div className="text-5xl font-semibold text-brand">404</div>
        <h1 className="mt-4 text-xl font-semibold">{tr("Page not found", "ಪುಟ ಕಂಡುಬಂದಿಲ್ಲ")}</h1>
        <p className="mt-2 text-sm text-muted">
          {tr(
            "The link may be outdated or the address may be incorrect.",
            "ಲಿಂಕ್ ಹಳೆಯದಾಗಿರಬಹುದು ಅಥವಾ ವಿಳಾಸ ತಪ್ಪಾಗಿರಬಹುದು.",
          )}
        </p>
        <button type="button" onClick={() => navigate("/")} className="mt-6 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white">
          {tr("Return to portal", "ಪೋರ್ಟಲ್‌ಗೆ ಹಿಂತಿರುಗಿ")}
        </button>
      </section>
    </main>
  );
};

export const SessionExpired: React.FC = () => {
  const navigate = useNavigate();
  const { tr } = useLanguage();

  return (
    <div className="flex min-h-[100dvh] flex-col overflow-x-hidden bg-ink text-white">
      <div className="gov-tricolor" aria-hidden="true" />

      <header className="border-b border-white/10 bg-gov-navy text-white">
        <div className="mx-auto flex min-h-14 w-full max-w-7xl items-center justify-between gap-3 px-4 py-2 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <KSPPBrandMark size="sm" className="shrink-0 ring-2 ring-white/15" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-semibold">{KSPP_NAME}</div>
              <div className="truncate text-[10px] font-medium text-white/65">
                {KSPP_KANNADA_NAME}
              </div>
            </div>
          </div>
          <div className="hidden text-right leading-tight sm:block">
            <div className="text-xs font-semibold">{KARNATAKA_GOVERNMENT_KANNADA}</div>
            <div className="mt-0.5 text-[9px] uppercase tracking-[0.12em] text-white/60">
              {KARNATAKA_GOVERNMENT}
            </div>
          </div>
        </div>
      </header>

      <main className="gov-login-bg flex flex-1 items-center px-4 py-8 sm:px-6 sm:py-12">
        <section className="mx-auto grid w-full max-w-4xl overflow-hidden rounded-2xl border border-line bg-shell shadow-gov lg:grid-cols-[.88fr_1.12fr]">
          <div className="relative hidden overflow-hidden bg-gov-navy p-8 text-white lg:flex lg:flex-col lg:justify-between">
            <div className="gov-panel-pattern" aria-hidden="true" />
            <div className="relative">
              <div className="inline-flex rounded-full bg-white p-1.5 shadow-xl">
                <KSPPBrandMark size="xl" />
              </div>
              <div className="mt-7 text-[11px] font-semibold uppercase tracking-[0.22em] text-gov-gold">
                {tr("Official Police Information System", "ಅಧಿಕೃತ ಪೊಲೀಸ್ ಮಾಹಿತಿ ವ್ಯವಸ್ಥೆ")}
              </div>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight">{KSPP_NAME}</h2>
              <p className="mt-2 text-sm font-semibold text-white/85">{KSPP_KANNADA_NAME}</p>
              <p className="mt-3 text-xs font-medium text-white/60">{tr(KSPP_TAGLINE, KSPP_TAGLINE_KANNADA)}</p>
            </div>

            <div className="relative mt-10 rounded-xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 shrink-0 text-gov-gold" size={20} aria-hidden="true" />
                <div>
                  <div className="text-sm font-semibold">
                    {tr("Secure session protection", "ಸುರಕ್ಷಿತ ಸೆಷನ್ ರಕ್ಷಣೆ")}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-white/65">
                    {tr(
                      "Automatic sign-out helps protect official police information.",
                      "ಸ್ವಯಂಚಾಲಿತ ಸೈನ್-ಔಟ್ ಅಧಿಕೃತ ಪೊಲೀಸ್ ಮಾಹಿತಿಯನ್ನು ರಕ್ಷಿಸಲು ಸಹಾಯ ಮಾಡುತ್ತದೆ.",
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="p-6 sm:p-10 lg:p-12">
            <div className="mb-7 flex items-center gap-3 lg:hidden">
              <KSPPBrandMark size="lg" className="shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand">KSPP</div>
                <div className="truncate text-sm font-semibold">{KSPP_NAME}</div>
                <div className="mt-0.5 truncate text-[10px] text-muted">{tr(KSPP_TAGLINE, KSPP_TAGLINE_KANNADA)}</div>
              </div>
            </div>

            <div className="inline-flex items-center gap-2 rounded-full border border-amber/25 bg-amber/10 px-3 py-1 text-[11px] font-semibold text-amber">
              <Clock3 size={14} aria-hidden="true" />
              {tr("Session timeout", "ಸೆಷನ್ ಟೈಮ್ಔಟ್")}
            </div>

            <h1 className="mt-5 text-2xl font-semibold tracking-tight sm:text-3xl">
              {tr("Your session has expired", "ನಿಮ್ಮ ಸೆಷನ್ ಅವಧಿ ಮುಗಿದಿದೆ")}
            </h1>
            <p className="mt-3 max-w-md text-sm leading-6 text-muted">
              {tr(
                "Your work saved as a browser draft is still available. Sign in again to continue.",
                "ಬ್ರೌಸರ್ ಕರಡಾಗಿ ಉಳಿಸಿದ ನಿಮ್ಮ ಕೆಲಸ ಇನ್ನೂ ಲಭ್ಯವಿದೆ. ಮುಂದುವರಿಸಲು ಮತ್ತೆ ಸೈನ್ ಇನ್ ಮಾಡಿ.",
              )}
            </p>

            <div className="mt-6 rounded-xl border border-line bg-panel/70 p-4 text-xs leading-5 text-muted">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 shrink-0 text-sage" size={18} aria-hidden="true" />
                <p>
                  {tr(
                    "For your security, please authenticate again to return to the portal.",
                    "ನಿಮ್ಮ ಸುರಕ್ಷತೆಗಾಗಿ, ಪೋರ್ಟಲ್ಗೆ ಹಿಂದಿರುಗಲು ದಯವಿಟ್ಟು ಮತ್ತೆ ದೃಢೀಕರಿಸಿ.",
                  )}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => navigate("/login", { replace: true })}
              className="mt-7 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand/90 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:ring-offset-2 focus:ring-offset-shell sm:w-auto"
            >
              {tr("Sign in again", "ಮತ್ತೆ ಸೈನ್ ಇನ್ ಮಾಡಿ")}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-shell px-4 py-4 text-center text-[11px] text-muted">
        <div className="font-medium text-white">© ಕರ್ನಾಟಕ ಸರ್ಕಾರ · ಕರ್ನಾಟಕ ರಾಜ್ಯ ಪೊಲೀಸ್</div>
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
