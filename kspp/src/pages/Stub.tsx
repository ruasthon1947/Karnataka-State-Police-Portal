import React from "react";
import { useNavigate } from "react-router-dom";
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
        {tr("Preview space - content for this screen lives in its page component.", "ಮುನ್ನೋಟ ಸ್ಥಳ — ಈ ಪರದೆಯ ವಿಷಯವು ಅದರ ಪುಟ ಘಟಕದಲ್ಲಿದೆ.")}
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
    <main className="grid min-h-[100dvh] place-items-center bg-ink px-4 text-white">
      <section className="w-full max-w-lg rounded-2xl border border-line bg-shell p-6 text-center shadow-soft sm:p-8">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-amber/30 bg-amber/10 text-xl text-amber" aria-hidden="true">⌛</div>
        <h1 className="mt-4 text-xl font-semibold">{tr("Your session has expired", "ನಿಮ್ಮ ಸೆಷನ್ ಅವಧಿ ಮುಗಿದಿದೆ")}</h1>
        <p className="mt-2 text-sm text-muted">
          {tr(
            "Your work saved as a browser draft is still available. Sign in again to continue.",
            "ಬ್ರೌಸರ್ ಕರಡಾಗಿ ಉಳಿಸಿದ ನಿಮ್ಮ ಕೆಲಸ ಇನ್ನೂ ಲಭ್ಯವಿದೆ. ಮುಂದುವರಿಸಲು ಮತ್ತೆ ಸೈನ್ ಇನ್ ಮಾಡಿ.",
          )}
        </p>
        <button type="button" onClick={() => navigate("/login", { replace: true })} className="mt-6 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white">
          {tr("Sign in again", "ಮತ್ತೆ ಸೈನ್ ಇನ್ ಮಾಡಿ")}
        </button>
      </section>
    </main>
  );
};
