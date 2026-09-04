import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { displayIdentifier } from "../lib/cases";
import { useLanguage } from "../context/LanguageContext";
import { displayPlaceName } from "../lib/kannadaPlaces";

type PassData = {
  CaseMasterID: string;
  CrimeNo: string;
  CaseNo: string;
  CrimeRegisteredDate: string;
  Officer: string;
  Status: string;
  ChargesheetStatus: string;
  PoliceStation: string;
};

const STATUS_STEPS = [
  { key: "registered", label: ["FIR Registered", "ಎಫ್‌ಐಆರ್ ನೋಂದಾಯಿಸಲಾಗಿದೆ"], icon: "✅" },
  { key: "assigned", label: ["Officer Assigned", "ಅಧಿಕಾರಿಯನ್ನು ನಿಯೋಜಿಸಲಾಗಿದೆ"], icon: "👮" },
  { key: "investigation", label: ["Investigation in Progress", "ತನಿಖೆ ಪ್ರಗತಿಯಲ್ಲಿದೆ"], icon: "🔍" },
  { key: "chargesheet", label: ["Charge Sheet Submitted", "ಆರೋಪಪಟ್ಟಿ ಸಲ್ಲಿಸಲಾಗಿದೆ"], icon: "📋" },
  { key: "closed", label: ["Case Closed", "ಪ್ರಕರಣ ಮುಚ್ಚಲಾಗಿದೆ"], icon: "🔒" },
];

function resolveStep(status: string, chargesheet: string): number {
  const s = (status || "").toLowerCase();
  const c = (chargesheet || "").toLowerCase();
  if (s.includes("closed") || s.includes("disposed") || s.includes("acquit")) return 4;
  if (c && !c.includes("pending") && !c.includes("not filed") && c !== "") return 3;
  if (s.includes("investigation") || s.includes("progress") || s.includes("pending")) return 2;
  if (s.includes("assigned") || s.includes("io assigned")) return 1;
  return 0;
}

const CasePass: React.FC = () => {
  const { language, setLanguage, tr } = useLanguage();
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PassData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("Invalid link. No case token provided.");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch(`/api/case-pass/${encodeURIComponent(token)}`, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || "Case information is unavailable.");
        return json;
      })
      .then((json) => {
        if (json.ok) setData(json.pass);
        else setError("This case pass could not be verified.");
        setCheckedAt(new Date());
      })
      .catch((requestError) => {
        if (requestError?.name !== "AbortError") {
          setData(null);
          setError(navigator.onLine ? "This case pass could not be verified. Check the link or try again." : "You are offline. Reconnect and try again.");
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [token, refreshKey]);

  const step = data ? resolveStep(data.Status, data.ChargesheetStatus) : 0;
  const caseLabel = data
    ? data.CrimeNo
      ? displayIdentifier(data.CrimeNo)
      : data.CaseNo
        ? `CR-${displayIdentifier(data.CaseNo)}`
        : `${tr("Case", "ಪ್ರಕರಣ")} ${displayIdentifier(data.CaseMasterID)}`
    : "";
  const displayedError = language === "kn"
    ? error.includes("offline")
      ? "ನೀವು ಆಫ್‌ಲೈನ್‌ನಲ್ಲಿದ್ದೀರಿ. ಮರುಸಂಪರ್ಕಿಸಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ."
      : "ಈ ಪ್ರಕರಣ ಪಾಸ್ ಅನ್ನು ಪರಿಶೀಲಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ಲಿಂಕ್ ಪರಿಶೀಲಿಸಿ ಅಥವಾ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ."
    : error;

  return (
    <div className="min-h-screen bg-[#0e0f11] flex flex-col items-center justify-center p-4 font-sans">
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-[#1a4fcf] flex items-center justify-center text-[#ffffff] font-bold text-sm">
          KP
        </div>
        <div>
          <div className="text-[#ffffff] font-semibold text-sm">{tr("Karnataka Police", "ಕರ್ನಾಟಕ ಪೊಲೀಸ್")}</div>
          <div className="text-[#6b7280] text-xs">{tr("Citizen Case Pass", "ನಾಗರಿಕ ಪ್ರಕರಣ ಪಾಸ್")}</div>
        </div>
        <div className="ml-3 flex rounded-lg border border-[#ffffff]/10 bg-[#17181c] p-0.5" role="group" aria-label={tr("Language", "ಭಾಷೆ")}>
          <button type="button" onClick={() => setLanguage("kn")} aria-pressed={language === "kn"} className={`rounded-md px-2 py-1 text-[10px] font-semibold ${language === "kn" ? "bg-[#1a4fcf] text-white" : "text-[#9ca3af]"}`}>ಕನ್ನಡ</button>
          <button type="button" onClick={() => setLanguage("en")} aria-pressed={language === "en"} className={`rounded-md px-2 py-1 text-[10px] font-semibold ${language === "en" ? "bg-[#1a4fcf] text-white" : "text-[#9ca3af]"}`}>EN</button>
        </div>
      </div>

      <div className="w-full max-w-sm rounded-2xl border border-[#ffffff]/10 bg-[#17181c] shadow-2xl overflow-hidden">
        {loading && (
          <div className="p-8 text-center text-[#6b7280] text-sm">{tr("Loading case information…", "ಪ್ರಕರಣದ ಮಾಹಿತಿ ಲೋಡ್ ಆಗುತ್ತಿದೆ…")}</div>
        )}

        {!loading && error && (
          <div className="p-8 text-center">
            <div className="text-3xl mb-3">⚠️</div>
            <div className="text-[#ffffff] font-semibold mb-1">{tr("Unable to verify case pass", "ಪ್ರಕರಣ ಪಾಸ್ ಪರಿಶೀಲಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ")}</div>
            <div className="text-[#6b7280] text-sm">{displayedError}</div>
            <button type="button" onClick={() => setRefreshKey((value) => value + 1)} className="mt-5 rounded-lg border border-[#4f8ef7]/40 px-4 py-2 text-xs font-semibold text-[#4f8ef7]">{tr("Try again", "ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ")}</button>
          </div>
        )}

        {!loading && data && (
          <>
            <div className="bg-[#1a4fcf]/15 border-b border-[#ffffff]/10 p-5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0 break-all text-[#4f8ef7] text-xs font-mono uppercase tracking-wider">{caseLabel}</div>
                <span className="shrink-0 rounded-full border border-[#22c55e]/30 bg-[#22c55e]/10 px-2 py-1 text-[10px] font-semibold text-[#4ade80]">✓ {tr("Verified", "ಪರಿಶೀಲಿಸಲಾಗಿದೆ")}</span>
              </div>
              <div className="text-[#ffffff] font-semibold text-lg">{displayPlaceName(data.PoliceStation, language) || tr("Karnataka Police", "ಕರ್ನಾಟಕ ಪೊಲೀಸ್")}</div>
              <div className="text-[#6b7280] text-xs mt-1">{tr("Registered", "ನೋಂದಣಿ")}: {data.CrimeRegisteredDate || tr("Date on record", "ದಾಖಲೆಯಲ್ಲಿರುವ ದಿನಾಂಕ")}</div>
            </div>

            <div className="p-5 space-y-3">
              <div className="text-[#9ca3af] text-xs font-medium uppercase tracking-wider mb-4">{tr("Case Status", "ಪ್ರಕರಣದ ಸ್ಥಿತಿ")}</div>
              {STATUS_STEPS.map((s, i) => {
                const done = i <= step;
                const current = i === step;
                return (
                  <div key={s.key} className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0 ${done ? current ? "bg-[#1a4fcf] ring-2 ring-[#4f8ef7]/50 text-[#ffffff]" : "bg-[#1a4fcf]/30 text-[#ffffff]" : "bg-[#ffffff]/5 text-[#374151]"}`}>
                      {done ? s.icon : "○"}
                    </div>
                    <div className={`text-sm font-medium ${done ? "text-[#ffffff]" : "text-[#374151]"}`}>{tr(s.label[0], s.label[1])}</div>
                    {current && (
                      <span className="ml-auto text-[10px] bg-[#1a4fcf]/20 text-[#4f8ef7] border border-[#1a4fcf]/30 rounded-full px-2 py-0.5 font-medium">{tr("Current", "ಪ್ರಸ್ತುತ")}</span>
                    )}
                  </div>
                );
              })}
            </div>

            {data.Officer && (
              <div className="border-t border-[#ffffff]/10 px-5 py-3 flex justify-between items-center">
                <span className="text-[#6b7280] text-xs">{tr("Investigating Officer", "ತನಿಖಾಧಿಕಾರಿ")}</span>
                <span className="text-[#ffffff] text-xs font-medium">{data.Officer.split(" ")[0]}</span>
              </div>
            )}

            <div className="border-t border-[#ffffff]/10 px-5 py-4">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(caseLabel);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1800);
                  } catch {
                    setCopied(false);
                  }
                }}
                className="w-full rounded-lg border border-[#ffffff]/10 px-3 py-2 text-xs font-semibold text-[#d1d5db] hover:border-[#4f8ef7]/50"
              >
                {copied ? tr("Reference copied", "ಉಲ್ಲೇಖವನ್ನು ನಕಲಿಸಲಾಗಿದೆ") : tr("Copy case reference", "ಪ್ರಕರಣದ ಉಲ್ಲೇಖವನ್ನು ನಕಲಿಸಿ")}
              </button>
              <p className="mt-2 text-center text-[10px] text-[#6b7280]">{checkedAt ? tr(`Last checked ${checkedAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`, `ಕೊನೆಯ ಪರಿಶೀಲನೆ ${checkedAt.toLocaleTimeString("kn-IN", { hour: "2-digit", minute: "2-digit" })}`) : tr("Live case status", "ನೇರ ಪ್ರಕರಣದ ಸ್ಥಿತಿ")}</p>
            </div>

            <div className="border-t border-[#ffffff]/10 bg-[#ffffff]/[0.02] p-4">
              <p className="text-[#6b7280] text-[11px] text-center leading-relaxed">
                {tr("For further details, visit your police station with this reference number. This page shows limited information for your privacy.", "ಹೆಚ್ಚಿನ ವಿವರಗಳಿಗಾಗಿ ಈ ಉಲ್ಲೇಖ ಸಂಖ್ಯೆಯೊಂದಿಗೆ ನಿಮ್ಮ ಪೊಲೀಸ್ ಠಾಣೆಗೆ ಭೇಟಿ ನೀಡಿ. ನಿಮ್ಮ ಗೌಪ್ಯತೆಗಾಗಿ ಈ ಪುಟದಲ್ಲಿ ಸೀಮಿತ ಮಾಹಿತಿಯನ್ನು ಮಾತ್ರ ತೋರಿಸಲಾಗಿದೆ.")}
              </p>
            </div>
          </>
        )}
      </div>

      <p className="mt-6 text-[#374151] text-[11px] text-center">
        © {tr("Government of Karnataka · Department of Police", "ಕರ್ನಾಟಕ ಸರ್ಕಾರ · ಪೊಲೀಸ್ ಇಲಾಖೆ")}
      </p>
    </div>
  );
};

export default CasePass;
