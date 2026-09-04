import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useLanguage } from "../context/LanguageContext";
import {
  CaseOptions,
  CaseRecord,
  caseKey,
  caseRoute,
  dedupeOptionValues,
  findCase,
  joinNames,
  optionList,
  saveCase,
  splitNames,
  subHeadOptions,
  todayIso,
  useCases,
} from "../lib/cases";
import { useAuth } from "../context/AuthContext";
import { requestFirDraft } from "../lib/chatApi";
import { AlertTriangle } from "lucide-react";
import { KSPPBrandMark } from "../components/brand/KSPPBrand";
import CasePassQR from "../components/CasePassQR";
import { displayKnownValue } from "../lib/kannadaValues";
import { displayPlaceName } from "../lib/kannadaPlaces";

function safeJsonParse(rawText: string) {
  if (!rawText) throw new Error("Received empty response from AI engine.");

  let cleaned = String(rawText)
    .replace(/^```(?:json)?/gi, "")
    .replace(/```$/gi, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  // Replace unescaped newlines/line breaks inside JSON strings with standard spaces
  cleaned = cleaned.replace(/[\r\n]+/g, " ");

  return JSON.parse(cleaned);
}

const STEPS = [
  {
    id: 1,
    title: "Case Basics",
    subtitle: "Save the case row before related details are entered",
  },
  {
    id: 2,
    title: "Incident Details",
    subtitle: "Facts, reporting date, incident window, and location",
  },
  {
    id: 3,
    title: "Complainant",
    subtitle: "Person or entity that filed the complaint",
  },
  {
    id: 4,
    title: "Victims",
    subtitle: "Victim names are stored in the Consolidated_Cases row",
  },
  {
    id: 5,
    title: "Accused",
    subtitle: "Accused details unlock only after the case exists",
  },
  {
    id: 6,
    title: "Acts & Sections",
    subtitle: "Statutes, sections, arrests, and chargesheet fields",
  },
  {
    id: 7,
    title: "Review & Submit",
    subtitle: "Submit once to update Google Sheets master",
  },
] as const;

const CASE_HEADERS = [
  "CaseMasterID",
  "CrimeNo",
  "CaseNo",
  "CrimeRegisteredDate",
  "CrimeHead",
  "CrimeSubHead",
  "PoliceStation",
  "PoliceStationType",
  "District",
  "Court",
  "EmployeeID",
  "Officer",
  "OfficerRank",
  "OfficerDesignation",
  "Status",
  "CaseCategory",
  "Gravity",
  "AccusedCount",
  "AccusedNames",
  "VictimCount",
  "VictimNames",
  "Complainant",
  "ArrestCount",
  "ChargesheetCount",
  "LatestChargesheetDate",
  "ChargesheetStatus",
  "Acts",
  "Sections",
  "InfoReceivedPSDate",
  "IncidentFromDate",
  "IncidentToDate",
  "Latitude",
  "Longitude",
  "BriefFacts",
  "FiledBy",
];

type FormState = Record<string, string>;

type SaveState = {
  status: "idle" | "saving" | "saved" | "error";
  message: string;
};

const emptyForm = (): FormState => ({
  CaseMasterID: "",
  CrimeNo: "",
  CaseNo: "",
  CrimeRegisteredDate: todayIso(),
  CrimeHead: "",
  CrimeSubHead: "",
  PoliceStation: "",
  PoliceStationType: "Police Station",
  District: "Bangalore Urban",
  Court: "",
  EmployeeID: "",
  Officer: "",
  OfficerRank: "",
  OfficerDesignation: "Investigating Officer (IO)",
  Status: "Under Investigation",
  CaseCategory: "FIR",
  Gravity: "Non-Heinous",
  AccusedCount: "0",
  AccusedNames: "",
  VictimCount: "0",
  VictimNames: "",
  Complainant: "",
  ArrestCount: "0",
  ChargesheetCount: "0",
  LatestChargesheetDate: "",
  ChargesheetStatus: "Pending",
  Acts: "",
  Sections: "",
  InfoReceivedPSDate: "",
  IncidentFromDate: "",
  IncidentToDate: "",
  Latitude: "",
  Longitude: "",
  BriefFacts: "",
  FiledBy: "",
});

const toForm = (record?: CaseRecord): FormState => {
  const base = emptyForm();
  if (!record) return base;
  for (const header of CASE_HEADERS) {
    base[header] = record[header] || "";
  }
  return base;
};

const buildPayload = (form: FormState, user?: { employeeId: string } | null): CaseRecord => {
  const payload: CaseRecord = {};
  for (const header of CASE_HEADERS) {
    payload[header] = form[header] || "";
  }
  payload.AccusedNames = joinNames(splitNames(payload.AccusedNames));
  payload.VictimNames = joinNames(splitNames(payload.VictimNames));
  payload.AccusedCount = String(splitNames(payload.AccusedNames).length);
  payload.VictimCount = String(splitNames(payload.VictimNames).length);

  if (user?.employeeId && !payload.FiledBy) {
    payload.FiledBy = user.employeeId;
  }

  return payload;
};

const inputClass =
  "w-full bg-shell border border-line rounded-lg px-3 py-2 text-sm text-white placeholder-muted outline-none focus:border-brand/50 focus:ring-2 focus:ring-brand/15 disabled:opacity-55 disabled:cursor-not-allowed";

const NEW_FIR_KANNADA: Record<string, string> = {
  "Case identity": "ಪ್ರಕರಣದ ಗುರುತು",
  "Case basics": "ಪ್ರಕರಣದ ಮೂಲ ವಿವರಗಳು",
  "Officer assignment": "ಅಧಿಕಾರಿ ನಿಯೋಜನೆ",
  CaseMasterID: "ಪ್ರಕರಣ ಮಾಸ್ಟರ್ ಐಡಿ",
  CaseNo: "ಪ್ರಕರಣ ಸಂಖ್ಯೆ",
  CrimeNo: "ಅಪರಾಧ ಸಂಖ್ಯೆ",
  CrimeRegisteredDate: "ಅಪರಾಧ ನೋಂದಣಿ ದಿನಾಂಕ",
  PoliceStation: "ಪೊಲೀಸ್ ಠಾಣೆ",
  PoliceStationType: "ಪೊಲೀಸ್ ಠಾಣೆಯ ಪ್ರಕಾರ",
  CrimeHead: "ಅಪರಾಧ ಶೀರ್ಷಿಕೆ",
  CrimeSubHead: "ಅಪರಾಧ ಉಪಶೀರ್ಷಿಕೆ",
  District: "ಜಿಲ್ಲೆ",
  CaseCategory: "ಪ್ರಕರಣ ವರ್ಗ",
  Gravity: "ಗಂಭೀರತೆ",
  Status: "ಸ್ಥಿತಿ",
  Court: "ನ್ಯಾಯಾಲಯ",
  EmployeeID: "ಉದ್ಯೋಗಿ ಐಡಿ",
  Officer: "ಅಧಿಕಾರಿ",
  OfficerRank: "ಅಧಿಕಾರಿ ಹುದ್ದೆ",
  OfficerDesignation: "ಅಧಿಕಾರಿ ಪದನಾಮ",
  BriefFacts: "ಸಂಕ್ಷಿಪ್ತ ಸಂಗತಿಗಳು",
  InfoReceivedPSDate: "ಠಾಣೆಗೆ ಮಾಹಿತಿ ಬಂದ ದಿನಾಂಕ",
  IncidentFromDate: "ಘಟನೆ ಆರಂಭ ದಿನಾಂಕ",
  IncidentToDate: "ಘಟನೆ ಅಂತ್ಯ ದಿನಾಂಕ",
  Latitude: "ಅಕ್ಷಾಂಶ",
  Longitude: "ರೇಖಾಂಶ",
  Complainant: "ದೂರುದಾರ",
  VictimNames: "ಸಂತ್ರಸ್ತರ ಹೆಸರುಗಳು",
  VictimCount: "ಸಂತ್ರಸ್ತರ ಸಂಖ್ಯೆ",
  AccusedNames: "ಆರೋಪಿತರ ಹೆಸರುಗಳು",
  AccusedCount: "ಆರೋಪಿತರ ಸಂಖ್ಯೆ",
  Acts: "ಕಾಯ್ದೆಗಳು",
  Sections: "ಸೆಕ್ಷನ್‌ಗಳು",
  ArrestCount: "ಬಂಧನಗಳ ಸಂಖ್ಯೆ",
  ChargesheetCount: "ಆರೋಪಪಟ್ಟಿಗಳ ಸಂಖ್ಯೆ",
  LatestChargesheetDate: "ಇತ್ತೀಚಿನ ಆರೋಪಪಟ್ಟಿ ದಿನಾಂಕ",
  ChargesheetStatus: "ಆರೋಪಪಟ್ಟಿ ಸ್ಥಿತಿ",
  "Select or type": "ಆಯ್ಕೆ ಮಾಡಿ ಅಥವಾ ಟೈಪ್ ಮಾಡಿ",
  "Select or type crime head": "ಅಪರಾಧ ಶೀರ್ಷಿಕೆಯನ್ನು ಆಯ್ಕೆ ಮಾಡಿ ಅಥವಾ ಟೈಪ್ ಮಾಡಿ",
  "Select or type crime sub-head": "ಅಪರಾಧ ಉಪಶೀರ್ಷಿಕೆಯನ್ನು ಆಯ್ಕೆ ಮಾಡಿ ಅಥವಾ ಟೈಪ್ ಮಾಡಿ",
  "Select or type court": "ನ್ಯಾಯಾಲಯವನ್ನು ಆಯ್ಕೆ ಮಾಡಿ ಅಥವಾ ಟೈಪ್ ಮಾಡಿ",
  "Select or type; separate multiple acts with semicolons": "ಆಯ್ಕೆ ಮಾಡಿ ಅಥವಾ ಟೈಪ್ ಮಾಡಿ; ಅನೇಕ ಕಾಯ್ದೆಗಳನ್ನು ಅರ್ಧವಿರಾಮದಿಂದ ಬೇರ್ಪಡಿಸಿ",
  "Select or type; separate multiple sections with semicolons": "ಆಯ್ಕೆ ಮಾಡಿ ಅಥವಾ ಟೈಪ್ ಮಾಡಿ; ಅನೇಕ ಸೆಕ್ಷನ್‌ಗಳನ್ನು ಅರ್ಧವಿರಾಮದಿಂದ ಬೇರ್ಪಡಿಸಿ",
  "This maps directly to the BriefFacts column.": "ಇದು ನೇರವಾಗಿ BriefFacts ಕಾಲಮ್‌ಗೆ ಹೊಂದಿಕೆಯಾಗುತ್ತದೆ.",
  "Consolidated_Cases stores one complainant text value.": "Consolidated_Cases ಒಬ್ಬ ದೂರುದಾರರ ಪಠ್ಯ ಮೌಲ್ಯವನ್ನು ಸಂಗ್ರಹಿಸುತ್ತದೆ.",
  "Enter one victim per line. Press Enter for each new name. Spaces in names are fully supported.": "ಪ್ರತಿ ಸಾಲಿನಲ್ಲಿ ಒಬ್ಬ ಸಂತ್ರಸ್ತರ ಹೆಸರನ್ನು ನಮೂದಿಸಿ. ಪ್ರತಿ ಹೊಸ ಹೆಸರಿಗೆ Enter ಒತ್ತಿರಿ.",
  "Enter one accused per line. Press Enter for each new name. Spaces in names are fully supported.": "ಪ್ರತಿ ಸಾಲಿನಲ್ಲಿ ಒಬ್ಬ ಆರೋಪಿಯ ಹೆಸರನ್ನು ನಮೂದಿಸಿ. ಪ್ರತಿ ಹೊಸ ಹೆಸರಿಗೆ Enter ಒತ್ತಿರಿ.",
};

const newFirCopy = (english: string) => NEW_FIR_KANNADA[english] || english;

const Section: React.FC<{ title?: string; children: React.ReactNode }> = ({
  title,
  children,
}) => {
  const { tr } = useLanguage();
  return <div className="mb-5">
    {title && (
      <div className="text-xs text-muted mb-2 uppercase tracking-wide">
        {tr(title, newFirCopy(title))}
      </div>
    )}
    {children}
  </div>;
};

const Field: React.FC<{
  label: string;
  children: React.ReactNode;
  hint?: string;
}> = ({ label, children, hint }) => {
  const { tr } = useLanguage();
  return <label className="block">
    <span className="block text-xs text-muted mb-1.5">{tr(label, newFirCopy(label))}</span>
    {children}
    {hint && <span className="block text-[11px] text-muted mt-1">{tr(hint, newFirCopy(hint))}</span>}
  </label>;
};

const OptionInput: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  field: string;
  placeholder?: string;
  disabled?: boolean;
  onOptionsOpen?: () => void;
}> = ({ label, value, onChange, options, field, placeholder, disabled, onOptionsOpen }) => {
  const { tr } = useLanguage();
  const listId = `fir-${field}-${React.useId().replace(/:/g, "")}`;
  const suggestions = useMemo(() => dedupeOptionValues(options), [options]);

  return (
    <Field label={label}>
      <div className="relative">
        <input
          type="text"
          name={field}
          list={disabled ? undefined : listId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={onOptionsOpen}
          disabled={disabled}
          autoComplete="off"
          placeholder={tr(placeholder || "Select or type", newFirCopy(placeholder || "Select or type"))}
          className={`${inputClass} new-fir-option-input pr-9`}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted"
        >
          ▼
        </span>
        <datalist id={listId}>
          {suggestions.map((item) => (
            <option key={item.toLocaleLowerCase()} value={item} />
          ))}
        </datalist>
      </div>
    </Field>
  );
};

const namesFromTextarea = (value: string) => joinNames(value.split(/\n|;/));
const textareaFromNames = (value: string) => splitNames(value).join("\n");

const demoFirstNames = [
  "Aarav",
  "Ananya",
  "Bhavya",
  "Chirag",
  "Deepa",
  "Eshwar",
  "Farhan",
  "Gowri",
  "Harish",
  "Isha",
  "Kiran",
  "Meera",
  "Naveen",
  "Pooja",
  "Rohan",
  "Sneha",
];

const demoLastNames = [
  "Rao",
  "Kumar",
  "Shetty",
  "Gowda",
  "Naidu",
  "Khan",
  "Patil",
  "Prasad",
  "Hegde",
  "Nair",
];

const pickDemo = (values: string[], fallback: string) =>
  values.length ? values[Math.floor(Math.random() * values.length)] : fallback;

const randomInt = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const randomName = () =>
  `${pickDemo(demoFirstNames, "Demo")} ${pickDemo(demoLastNames, "User")}`;

const randomRecentDate = () => {
  const date = new Date();
  date.setDate(date.getDate() - randomInt(0, 45));
  return date.toISOString().slice(0, 10);
};

const randomDateTime = (date = randomRecentDate()) =>
  `${date} ${String(randomInt(0, 23)).padStart(2, "0")}:${String(
    randomInt(0, 59),
  ).padStart(2, "0")}:00`;

const notificationMessage = (
  notifications?: {
    event: "new_fir" | "status_update";
    eligible: number;
    sent: number;
    failed: number;
  } | null,
  language: "en" | "kn" = "en",
) => {
  if (!notifications) return "";
  if (language === "kn") {
    if (notifications.sent > 0 && notifications.failed === 0) return ` ${notifications.sent} ಅಧಿಕಾರಿಗೆ SMS ಎಚ್ಚರಿಕೆ ಕಳುಹಿಸಲಾಗಿದೆ.`;
    if (notifications.sent > 0) return ` SMS ಎಚ್ಚರಿಕೆಗಳು: ${notifications.sent} ಕಳುಹಿಸಲಾಗಿದೆ, ${notifications.failed} ವಿಫಲವಾಗಿದೆ.`;
    if (notifications.failed > 0) return " ಎಫ್‌ಐಆರ್ ಉಳಿಸಲಾಗಿದೆ, ಆದರೆ SMS ವಿತರಣೆ ವಿಫಲವಾಗಿದೆ. SMS ಸಂರಚನೆಯನ್ನು ಪರಿಶೀಲಿಸಿ.";
    return " ದೃಢೀಕೃತ ಮತ್ತು ಒಪ್ಪಿಗೆ ನೀಡಿದ ಯಾವುದೇ ಅಧಿಕಾರಿ ಈ ಎಚ್ಚರಿಕೆಗೆ ಹೊಂದಿಕೆಯಾಗಲಿಲ್ಲ.";
  }
  if (notifications.sent > 0 && notifications.failed === 0) {
    return ` SMS alert sent to ${notifications.sent} officer${notifications.sent === 1 ? "" : "s"}.`;
  }
  if (notifications.sent > 0) {
    return ` SMS alerts: ${notifications.sent} sent, ${notifications.failed} failed.`;
  }
  if (notifications.failed > 0) {
    return " The FIR was saved, but SMS delivery failed. Check the SMS provider configuration.";
  }
  return " No verified, opted-in officers matched this alert.";
};

const syncMessage = (
  sync: { ok: boolean; skipped?: boolean; message?: string; stderr?: string },
  notifications?: {
    event: "new_fir" | "status_update";
    eligible: number;
    sent: number;
    failed: number;
  } | null,
  language: "en" | "kn" = "en",
) => {
  if (language === "kn") {
    if (sync.ok) return sync.skipped
      ? "ಸ್ಥಳೀಯ ಕರಡು ಉಳಿಸಲಾಗಿದೆ. ಎಫ್‌ಐಆರ್ ಸಲ್ಲಿಸಿದಾಗ Google Sheets ನವೀಕರಿಸುತ್ತದೆ."
      : `ಎಫ್‌ಐಆರ್ ಸಲ್ಲಿಸಲಾಗಿದೆ. Google Sheets ಮಾಸ್ಟರ್ ನವೀಕರಿಸಲಾಗಿದೆ.${notificationMessage(notifications, language)}`;
    return `ಸ್ಥಳೀಯ ಉಳಿಸುವಿಕೆ ಪೂರ್ಣವಾಗಿದೆ, ಆದರೆ Google ಸಿಂಕ್‌ಗೆ ಗಮನ ಅಗತ್ಯ: ${sync.stderr || sync.message || "ಸ್ಕ್ರಿಪ್ಟ್ ವಿಫಲವಾಗಿದೆ"}`;
  }
  if (sync.ok) {
    return sync.skipped
      ? "Local draft saved. Google Sheets will update once you click Submit FIR."
      : `FIR submitted. Google Sheets master was updated.${notificationMessage(notifications, language)}`;
  }
  return `Local save complete, but Google sync needs attention: ${sync.stderr || sync.message || "script failed"}`;
};

type FirDraft = {
  form: FormState;
  complaint: string;
  aiReady: boolean;
  step: number;
  highestUnlocked: number;
};

const draftStorageKey = (employeeId: string, caseId?: string) =>
  `kpfir.firDraft.${employeeId}.${caseId || "new"}`;

const readDraft = (key: string): FirDraft | null => {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FirDraft>;
    if (!parsed.form || typeof parsed.form !== "object") return null;
    return {
      form: { ...emptyForm(), ...parsed.form },
      complaint: String(parsed.complaint || ""),
      aiReady: Boolean(parsed.aiReady),
      step: Math.min(STEPS.length, Math.max(1, Number(parsed.step) || 1)),
      highestUnlocked: Math.min(
        STEPS.length,
        Math.max(1, Number(parsed.highestUnlocked) || 1),
      ),
    };
  } catch {
    return null;
  }
};

const NewFIR: React.FC = () => {
  const { language, tr } = useLanguage();
  const navigate = useNavigate();
  const { id } = useParams();
  const editing = Boolean(id);
  const { user } = useAuth();
  const draftKey = draftStorageKey(user?.employeeId || "unknown", id);
  const [initialDraft] = useState<FirDraft | null>(() => readDraft(draftKey));
  const { cases, options, loading, error, reload } = useCases();

  const existingCase = useMemo(() => findCase(cases, id), [cases, id]);
  const [loadedKey, setLoadedKey] = useState(
    editing && initialDraft ? decodeURIComponent(id || "") : "",
  );
  const [step, setStep] = useState(initialDraft?.step || 1);
  const [highestUnlocked, setHighestUnlocked] = useState(
    initialDraft?.highestUnlocked || (editing ? STEPS.length : 1),
  );
  const [persistedCaseId, setPersistedCaseId] = useState(
    editing ? decodeURIComponent(id || "") : "",
  );
  const [aiLoading, setAiLoading] = useState(false);
  const [form, setForm] = useState<FormState>(
    () => initialDraft?.form || emptyForm(),
  );
  const [complaint, setComplaint] = useState(initialDraft?.complaint || "");
  const [aiReady, setAiReady] = useState(initialDraft?.aiReady || false);
  const [saveState, setSaveState] = useState<SaveState>({
    status: "idle",
    message: "",
  });
  const [successRoute, setSuccessRoute] = useState("");
  const [successNotice, setSuccessNotice] = useState("");
  const [showQR, setShowQR] = useState(false);

  useEffect(() => {
    if (!editing || !existingCase) return;
    const key = caseKey(existingCase);
    if (key && key !== loadedKey) {
      setForm(toForm(existingCase));
      setPersistedCaseId(key);
      setHighestUnlocked(STEPS.length);
      setLoadedKey(key);
    }
  }, [editing, existingCase, loadedKey]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({ form, complaint, aiReady, step, highestUnlocked }),
      );
    } catch {
      // The explicit Save locally action reports storage failures to the user.
    }
  }, [draftKey, form, complaint, aiReady, step, highestUnlocked]);

  const persisted = editing || highestUnlocked > 1;
  const meta = STEPS[step - 1];
  const accusedCount = splitNames(form.AccusedNames).length;
  const victimCount = splitNames(form.VictimNames).length;

  const [duplicateModalOpen, setDuplicateModalOpen] = useState(false);

  const normalizePersonName = (value: string) =>
    String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const duplicateCases = useMemo(() => {
    const formAccused = splitNames(form.AccusedNames).map(normalizePersonName).filter(Boolean);
    const formVictims = splitNames(form.VictimNames).map(normalizePersonName).filter(Boolean);

    if (formAccused.length === 0 && formVictims.length === 0) return [];

    return cases.filter((c) => {
      if (form.CaseMasterID && String(c.CaseMasterID) === String(form.CaseMasterID)) return false;
      if (form.CrimeNo && String(c.CrimeNo) === String(form.CrimeNo)) return false;
      if (editing && String(c.CaseMasterID) === String(loadedKey)) return false;

      const caseAccused = splitNames(c.AccusedNames).map(normalizePersonName).filter(Boolean);
      const caseVictims = splitNames(c.VictimNames).map(normalizePersonName).filter(Boolean);

      const accusedOverlap = formAccused.length > 0 && caseAccused.length > 0 &&
        formAccused.some((n) => n !== "unknown" && caseAccused.some((existing) => existing === n));
      const victimOverlap = formVictims.length > 0 && caseVictims.length > 0 &&
        formVictims.some((n) => n !== "unknown" && caseVictims.some((existing) => existing === n));

      return accusedOverlap || victimOverlap;
    });
  }, [cases, form.AccusedNames, form.CaseMasterID, form.CrimeNo, form.VictimNames, editing, loadedKey]);

  // Auto-show modal when new duplicates are detected
  const prevDupCount = React.useRef(0);
  useEffect(() => {
    if (duplicateCases.length > 0 && prevDupCount.current === 0) {
      setDuplicateModalOpen(true);
    }
    prevDupCount.current = duplicateCases.length;
  }, [duplicateCases.length]);

  const update = (field: string, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setSaveState((current) =>
      current.status === "saved" ? { status: "idle", message: "" } : current,
    );
  };

  const saveCurrentStep = async (syncNow = false) => {
    if (!form.CrimeRegisteredDate || !form.PoliceStation || !form.CrimeHead) {
      setSaveState({
        status: "error",
        message: tr("CrimeRegisteredDate, PoliceStation, and CrimeHead are required before the case row can be saved.", "ಪ್ರಕರಣದ ಸಾಲನ್ನು ಉಳಿಸುವ ಮೊದಲು ಅಪರಾಧ ನೋಂದಣಿ ದಿನಾಂಕ, ಪೊಲೀಸ್ ಠಾಣೆ ಮತ್ತು ಅಪರಾಧ ಶೀರ್ಷಿಕೆ ಅಗತ್ಯವಿದೆ."),
      });
      return null;
    }

    if (!syncNow) {
      try {
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({
            form,
            complaint,
            aiReady,
            step,
            highestUnlocked,
          }),
        );
        setSaveState({
          status: "saved",
          message: tr("Draft saved in this browser tab. Submit FIR to update Google Sheets.", "ಕರಡನ್ನು ಈ ಬ್ರೌಸರ್ ಟ್ಯಾಬ್‌ನಲ್ಲಿ ಉಳಿಸಲಾಗಿದೆ. Google Sheets ನವೀಕರಿಸಲು ಎಫ್‌ಐಆರ್ ಸಲ್ಲಿಸಿ."),
        });
        return {
          ok: true,
          created: !editing,
          headers: CASE_HEADERS,
          case: buildPayload(form, user),
          options,
          notifications: null,
          sync: { ok: true, skipped: true, message: "Draft saved locally." },
        };
      } catch {
        setSaveState({
          status: "error",
          message: tr("This browser could not save the draft. Keep this page open and try again.", "ಈ ಬ್ರೌಸರ್ ಕರಡನ್ನು ಉಳಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ಈ ಪುಟವನ್ನು ತೆರೆದಿರಿಸಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ."),
        });
        return null;
      }
    }

    setSaveState({
      status: "saving",
      message: tr("Submitting FIR and updating Google Sheets...", "ಎಫ್‌ಐಆರ್ ಸಲ್ಲಿಸಿ Google Sheets ನವೀಕರಿಸಲಾಗುತ್ತಿದೆ..."),
    });

    try {
      const result = await saveCase(
        buildPayload(form, user),
        editing ? persistedCaseId || id : undefined,
      );

      const nextForm = toForm(result.case);
      const nextKey = caseKey(result.case);

      setForm(nextForm);
      setPersistedCaseId(nextKey);
      setLoadedKey(nextKey);
      setSaveState({
        status: result.sync.ok ? "saved" : "error",
        message: syncMessage(result.sync, result.notifications, language),
      });
      await reload();
      return result;
    } catch (error) {
      setSaveState({
        status: "error",
        message:
          language === "kn"
            ? "ಎಫ್‌ಐಆರ್ ಸಲ್ಲಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ನಿಮ್ಮ ಸ್ಥಳೀಯ ಕರಡು ಇನ್ನೂ ಲಭ್ಯವಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ."
            : error instanceof Error
              ? error.message
              : "The FIR could not be submitted. Your local draft is still available.",
      });
      return null;
    }
  };

  const goNext = async () => {
    const result = await saveCurrentStep(false);
    if (!result) return;
    setHighestUnlocked((current) => Math.max(current, Math.min(STEPS.length, step + 1)));
    setStep((current) => Math.min(STEPS.length, current + 1));
  };

  const submit = async () => {
    const result = await saveCurrentStep(true);
    if (result?.sync.ok) {
      sessionStorage.removeItem(draftKey);
      setSuccessNotice(notificationMessage(result.notifications, language).trim());
      setSuccessRoute(`/fir/${caseRoute(result.case)}`);
    }
  };

  const generateDraft = async () => {
    if (!complaint.trim()) return;
    setAiLoading(true);
    setSaveState({ status: "idle", message: "" });

    try {
      const optionFields = [
        "CrimeHead",
        "CrimeSubHead",
        "PoliceStation",
        "PoliceStationType",
        "District",
        "Court",
        "Officer",
        "OfficerRank",
        "OfficerDesignation",
        "CaseCategory",
        "Gravity",
        "Status",
        "Acts",
        "Sections",
        "ChargesheetStatus",
      ];
      const allowedValues = Object.fromEntries(
        optionFields.map((field) => [field, optionList(options, field).slice(0, 15)]),
      );
      const parsedData = await requestFirDraft(complaint, {
        allowedValues,
        defaults: {
          CrimeRegisteredDate: form.CrimeRegisteredDate || todayIso(),
          PoliceStation: form.PoliceStation || user?.policeStation || "",
          PoliceStationType: form.PoliceStationType || "Police Station",
          District: form.District || "Bangalore Urban",
          EmployeeID: form.EmployeeID || user?.employeeId || "",
          Officer: form.Officer || user?.name || "",
          OfficerRank: form.OfficerRank || user?.role || "",
          OfficerDesignation: form.OfficerDesignation || "Investigating Officer (IO)",
          Status: form.Status || "Under Investigation",
          CaseCategory: form.CaseCategory || "FIR",
          Gravity: form.Gravity || "Non-Heinous",
          FiledBy: form.FiledBy || user?.employeeId || "",
        },
      });

      // 🚀 Auto-fill ALL fields across all 7 steps (including IDs)
      setForm((current) => ({
        ...current,
        // Step 1: Case Identity & Basics
        CaseMasterID: parsedData.CaseMasterID || current.CaseMasterID,
        CaseNo: parsedData.CaseNo || current.CaseNo,
        CrimeNo: parsedData.CrimeNo || current.CrimeNo,
        CrimeRegisteredDate: parsedData.CrimeRegisteredDate || current.CrimeRegisteredDate || todayIso(),
        PoliceStation: parsedData.PoliceStation || current.PoliceStation || user?.policeStation || "",
        PoliceStationType: parsedData.PoliceStationType || current.PoliceStationType,
        District: parsedData.District || current.District || "Bangalore Urban",
        CrimeHead: parsedData.CrimeHead || current.CrimeHead,
        CrimeSubHead: parsedData.CrimeSubHead || current.CrimeSubHead || "",
        CaseCategory: parsedData.CaseCategory || current.CaseCategory || "FIR",
        Gravity: parsedData.Gravity || current.Gravity || "Non-Heinous",
        Status: parsedData.Status || current.Status || "Under Investigation",
        Court: parsedData.Court || current.Court,
        EmployeeID: parsedData.EmployeeID || current.EmployeeID || user?.employeeId || "",
        Officer: parsedData.Officer || current.Officer || user?.name || "",
        OfficerRank: parsedData.OfficerRank || current.OfficerRank,
        OfficerDesignation: parsedData.OfficerDesignation || current.OfficerDesignation || "Investigating Officer (IO)",

        // Step 2: Incident Details
        BriefFacts: parsedData.BriefFacts || complaint,
        InfoReceivedPSDate: parsedData.InfoReceivedPSDate || current.InfoReceivedPSDate,
        IncidentFromDate: parsedData.IncidentFromDate || current.IncidentFromDate,
        IncidentToDate: parsedData.IncidentToDate || current.IncidentToDate,
        Latitude: parsedData.Latitude || current.Latitude,
        Longitude: parsedData.Longitude || current.Longitude,

        // Step 3: Complainant
        Complainant: parsedData.Complainant || current.Complainant,

        // Step 4: Victims
        VictimNames: parsedData.VictimNames || current.VictimNames || "",
        VictimCount: parsedData.VictimCount || current.VictimCount || "0",

        // Step 5: Accused
        AccusedNames: parsedData.AccusedNames || current.AccusedNames,
        AccusedCount: parsedData.AccusedCount || current.AccusedCount || "0",

        // Step 6: Acts & Sections
        Acts: parsedData.Acts || current.Acts,
        Sections: parsedData.Sections || current.Sections,
        ArrestCount: parsedData.ArrestCount || current.ArrestCount || "0",
        ChargesheetCount: parsedData.ChargesheetCount || current.ChargesheetCount || "0",
        LatestChargesheetDate: parsedData.LatestChargesheetDate || current.LatestChargesheetDate,
        ChargesheetStatus: parsedData.ChargesheetStatus || current.ChargesheetStatus || "Pending",
        FiledBy: parsedData.FiledBy || current.FiledBy || user?.employeeId || "",
      }));

      setAiReady(true);
      setSaveState({
        status: "saved",
        message: tr("AI Assistant extracted the available details. Review every field before saving or submitting.", "ಎಐ ಸಹಾಯಕ ಲಭ್ಯವಿರುವ ವಿವರಗಳನ್ನು ಹೊರತೆಗೆದಿದೆ. ಉಳಿಸುವ ಅಥವಾ ಸಲ್ಲಿಸುವ ಮೊದಲು ಪ್ರತಿ ಕ್ಷೇತ್ರವನ್ನು ಪರಿಶೀಲಿಸಿ.")
      });
    } catch (err: any) {
      console.error("[Autonomous Auto-Fill Failure]:", err);
      setSaveState({
        status: "error",
        message: tr(`AI Draft extraction error: ${err.message || "Failed to parse JSON format"}. Please review fields manually.`, "ಎಐ ಕರಡು ವಿವರ ಹೊರತೆಗೆಯುವಲ್ಲಿ ದೋಷವಾಗಿದೆ. ದಯವಿಟ್ಟು ಕ್ಷೇತ್ರಗಳನ್ನು ಕೈಯಾರೆ ಪರಿಶೀಲಿಸಿ.")
      });
    } finally {
      setAiLoading(false);
    }
  };

  const stationOptions = optionList(options, "PoliceStation");
  const crimeHeadOptions = optionList(options, "CrimeHead");
  const crimeSubHeadOptions = subHeadOptions(options, form.CrimeHead);
  const refreshOptions = () => {
    void reload(true);
  };

  const fillDemoForStep = () => {
    setForm((current) => {
      const registeredDate = current.CrimeRegisteredDate || randomRecentDate();
      const crimeHead = pickDemo(crimeHeadOptions, "Cyber Crime");
      const crimeSubHead = pickDemo(subHeadOptions(options, crimeHead), "Online Financial Fraud");
      const victimNames = Array.from({ length: randomInt(1, 3) }, randomName);
      const accusedNames = Array.from({ length: randomInt(1, 3) }, () =>
        Math.random() > 0.25 ? randomName() : "Unknown",
      );
      const acts = pickDemo(optionList(options, "Acts"), "BNS");
      const sections = pickDemo(optionList(options, "Sections"), "Cheating");

      switch (step) {
        case 1:
          return {
            ...current,
            CrimeRegisteredDate: registeredDate,
            CrimeHead: crimeHead,
            CrimeSubHead: crimeSubHead,
            PoliceStation: pickDemo(stationOptions, "Jayanagar Police Station"),
            PoliceStationType: pickDemo(optionList(options, "PoliceStationType"), "Police Station"),
            District: pickDemo(optionList(options, "District"), "Bangalore Urban"),
            Court: pickDemo(optionList(options, "Court"), "Court of ACMM Bengaluru"),
            EmployeeID: String(randomInt(200, 999)),
            Officer: pickDemo(optionList(options, "Officer"), randomName().split(" ")[0]),
            OfficerRank: pickDemo(optionList(options, "OfficerRank"), "Inspector of Police"),
            OfficerDesignation: pickDemo(
              optionList(options, "OfficerDesignation"),
              "Investigating Officer (IO)",
            ),
            Status: pickDemo(optionList(options, "Status"), "Under Investigation"),
            CaseCategory: pickDemo(optionList(options, "CaseCategory"), "FIR"),
            Gravity: pickDemo(optionList(options, "Gravity"), "Non-Heinous"),
          };
        case 2: {
          const infoDate = randomDateTime(registeredDate);
          return {
            ...current,
            InfoReceivedPSDate: infoDate,
            IncidentFromDate: randomDateTime(registeredDate),
            IncidentToDate: randomDateTime(registeredDate),
            Latitude: `12.${randomInt(850000, 999999)}`,
            Longitude: `77.${randomInt(450000, 750000)}`,
            BriefFacts: `Demo complaint: ${randomName()} reported a ${current.CrimeSubHead || crimeSubHead} incident near ${current.PoliceStation || "the selected police station"}. The officer recorded preliminary facts for testing the save flow.`,
          };
        }
        case 3:
          return {
            ...current,
            Complainant: randomName(),
          };
        case 4:
          return {
            ...current,
            VictimNames: joinNames(victimNames),
            VictimCount: String(victimNames.length),
          };
        case 5:
          return {
            ...current,
            AccusedNames: joinNames(accusedNames),
            AccusedCount: String(accusedNames.length),
          };
        case 6:
          return {
            ...current,
            Acts: acts,
            Sections: sections,
            ArrestCount: String(randomInt(0, Math.max(1, splitNames(current.AccusedNames).length))),
            ChargesheetCount: String(randomInt(0, 1)),
            LatestChargesheetDate: Math.random() > 0.5 ? randomRecentDate() : "",
            ChargesheetStatus: pickDemo(optionList(options, "ChargesheetStatus"), "Pending"),
          };
        case 7:
          return {
            ...current,
            CrimeRegisteredDate: current.CrimeRegisteredDate || registeredDate,
            CrimeHead: current.CrimeHead || crimeHead,
            CrimeSubHead: current.CrimeSubHead || crimeSubHead,
            PoliceStation: current.PoliceStation || pickDemo(stationOptions, "Jayanagar Police Station"),
            Complainant: current.Complainant || randomName(),
            VictimNames: current.VictimNames || joinNames(victimNames),
            VictimCount: current.VictimCount || String(victimNames.length),
            AccusedNames: current.AccusedNames || joinNames(accusedNames),
            AccusedCount: current.AccusedCount || String(accusedNames.length),
            Acts: current.Acts || acts,
            Sections: current.Sections || sections,
            BriefFacts:
              current.BriefFacts ||
              `Demo complaint: ${randomName()} reported a test case for validating the Consolidated_Cases flow.`,
          };
        default:
          return current;
      }
    });

    setSaveState({
      status: "idle",
      message: `Demo data filled for ${meta.title}. Review it, then click Save step.`,
    });
  };

  if (loading && editing && !existingCase) {
    return <div className="p-6 text-sm text-muted">{tr("Loading case from Google Sheets...", "Google Sheets ನಿಂದ ಪ್ರಕರಣ ಲೋಡ್ ಆಗುತ್ತಿದೆ...")}</div>;
  }

  if (error && editing && !existingCase) {
    return <div className="p-6 text-sm text-rose">{error}</div>;
  }
  if (editing && !loading && !existingCase) {
    return <div className="p-6 text-sm text-muted">{tr("Case not found in Google Sheets master.", "Google Sheets ಮಾಸ್ಟರ್‌ನಲ್ಲಿ ಪ್ರಕರಣ ಕಂಡುಬಂದಿಲ್ಲ.")}</div>;
  }

  return (
    <div className="new-fir-page min-h-full overflow-x-hidden bg-ink text-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-ink px-4 py-3 sm:px-6">
        <h2 className="text-white text-sm font-medium">
          {editing ? tr("Edit FIR", "ಎಫ್‌ಐಆರ್ ಸಂಪಾದಿಸಿ") : tr("New FIR", "ಹೊಸ ಎಫ್‌ಐಆರ್")}
        </h2>
        <div className="text-[11px] text-muted sm:text-xs">
          {tr("Options", "ಆಯ್ಕೆಗಳು")}: <span className="text-white">{tr("Live from Google Sheets", "Google Sheets ನಿಂದ ನೇರ ಮಾಹಿತಿ")}</span>
        </div>
      </div>

      <div className="px-4 pt-4 sm:px-6 sm:pt-6">
        {/* Duplicate FIR Modal */}
        {duplicateModalOpen && duplicateCases.length > 0 && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="w-full max-w-2xl rounded-2xl border border-rose/40 bg-panel shadow-2xl shadow-rose/10">
              <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-line">
                <div>
                  <div className="flex items-center gap-2 text-rose font-semibold text-base">
                    <AlertTriangle className="text-rose" size={20} />
                    <span>{tr(`Similar Case${duplicateCases.length > 1 ? "s" : ""} Found`, `ಹೋಲುವ ${duplicateCases.length > 1 ? "ಪ್ರಕರಣಗಳು" : "ಪ್ರಕರಣ"} ಕಂಡುಬಂದಿದೆ`)}</span>
                  </div>
                  <p className="text-xs text-muted mt-1">
                    {tr(`The details you entered match ${duplicateCases.length} existing FIR${duplicateCases.length > 1 ? "s" : ""}. Review before submitting to avoid duplicates.`, `ನೀವು ನಮೂದಿಸಿದ ವಿವರಗಳು ಈಗಿರುವ ${duplicateCases.length} ಎಫ್‌ಐಆರ್‌ಗೆ ಹೊಂದಿಕೆಯಾಗುತ್ತವೆ. ನಕಲು ತಪ್ಪಿಸಲು ಸಲ್ಲಿಸುವ ಮೊದಲು ಪರಿಶೀಲಿಸಿ.`)}
                  </p>
                </div>
                <button
                  onClick={() => setDuplicateModalOpen(false)}
                  className="shrink-0 text-muted hover:text-white text-xl leading-none"
                  aria-label={tr("Close", "ಮುಚ್ಚಿ")}
                >×</button>
              </div>
              <div className="overflow-y-auto max-h-[60vh] divide-y divide-line">
                {duplicateCases.map((dc) => (
                  <div key={dc.CaseMasterID} className="px-6 py-4">
                    <div className="flex flex-wrap items-center gap-2 mb-3">
                      <span className="text-white font-semibold text-sm">{tr("FIR No", "ಎಫ್‌ಐಆರ್ ಸಂಖ್ಯೆ")}: {dc.CrimeNo || '-'}</span>
                      <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">{tr("ID", "ಐಡಿ")}: {dc.CaseMasterID}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${(dc.Status || '').toLowerCase().includes('solved') || (dc.Status || '').toLowerCase().includes('closed')
                          ? 'bg-sage/15 text-sage' : 'bg-amber/15 text-amber'
                        }`}>{displayKnownValue(dc.Status || "Unknown", language)}</span>
                      <button
                        onClick={() => {
                          setDuplicateModalOpen(false);
                          navigate(`/fir/${caseRoute(dc)}`);
                        }}
                        className="ml-auto px-3 py-1.5 text-xs font-semibold rounded-lg bg-rose/20 text-rose border border-rose/30 hover:bg-rose/30"
                      >
                        {tr("View Case", "ಪ್ರಕರಣ ನೋಡಿ")}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                      {[
                        [tr('Police Station', 'ಪೊಲೀಸ್ ಠಾಣೆ'), displayPlaceName(dc.PoliceStation, language)],
                        [tr('Crime Head', 'ಅಪರಾಧ ಶೀರ್ಷಿಕೆ'), displayKnownValue(dc.CrimeHead, language)],
                        [tr('Crime Sub-Head', 'ಅಪರಾಧ ಉಪಶೀರ್ಷಿಕೆ'), displayKnownValue(dc.CrimeSubHead, language)],
                        [tr('Registered Date', 'ನೋಂದಣಿ ದಿನಾಂಕ'), dc.CrimeRegisteredDate],
                        [tr('Complainant', 'ದೂರುದಾರ'), dc.Complainant],
                        [tr('Officer', 'ಅಧಿಕಾರಿ'), dc.Officer],
                        [tr('Accused', 'ಆರೋಪಿತರು'), dc.AccusedNames],
                        [tr('Victims', 'ಸಂತ್ರಸ್ತರು'), dc.VictimNames],
                      ].map(([label, val]) => val ? (
                        <div key={label} className="flex gap-1">
                          <span className="text-muted shrink-0">{label}:</span>
                          <span className="text-white">{val}</span>
                        </div>
                      ) : null)}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-3 px-6 py-4 border-t border-line">
                <button
                  onClick={() => setDuplicateModalOpen(false)}
                  className="px-4 py-2 text-sm font-semibold rounded-lg border border-line text-muted hover:text-white hover:bg-panel"
                >
                  {tr("Continue Anyway", "ಆದರೂ ಮುಂದುವರಿಸಿ")}
                </button>
              </div>
            </div>
          </div>
        )}
        {duplicateCases.length > 0 && !duplicateModalOpen && (
          <button
            onClick={() => setDuplicateModalOpen(true)}
            className="mx-auto max-w-6xl mb-4 w-full text-left rounded-xl border border-rose/30 bg-rose/10 px-4 py-3 text-sm text-rose hover:bg-rose/15 transition"
          >
            <strong>{tr(`${duplicateCases.length} similar case${duplicateCases.length > 1 ? "s" : ""} found`, `${duplicateCases.length} ಹೋಲುವ ${duplicateCases.length > 1 ? "ಪ್ರಕರಣಗಳು" : "ಪ್ರಕರಣ"} ಕಂಡುಬಂದಿದೆ`)}</strong> - {tr("FIR", "ಎಫ್‌ಐಆರ್")} {duplicateCases.map(d => d.CrimeNo).join(', ')}. {tr("Click to review.", "ಪರಿಶೀಲಿಸಲು ಕ್ಲಿಕ್ ಮಾಡಿ.")}
          </button>
        )}

        <div className="mx-auto max-w-6xl rounded-2xl border border-line bg-shell p-4 sm:p-5">
          <div className="flex flex-col gap-3 min-[600px]:flex-row min-[600px]:items-start min-[600px]:justify-between">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-white">
                {tr("AI FIR Draft Assistant", "ಎಐ ಎಫ್‌ಐಆರ್ ಕರಡು ಸಹಾಯಕ")}
              </h1>
              <p className="text-xs text-muted mt-1">
                {tr("Enter a complaint draft and review each step. Drafts stay in this browser tab; Submit FIR updates Google Sheets once.", "ದೂರಿನ ಕರಡನ್ನು ನಮೂದಿಸಿ ಮತ್ತು ಪ್ರತಿ ಹಂತವನ್ನು ಪರಿಶೀಲಿಸಿ. ಕರಡುಗಳು ಈ ಬ್ರೌಸರ್ ಟ್ಯಾಬ್‌ನಲ್ಲಿ ಉಳಿಯುತ್ತವೆ; ಎಫ್‌ಐಆರ್ ಸಲ್ಲಿಸಿದಾಗ Google Sheets ಒಮ್ಮೆ ನವೀಕರಿಸುತ್ತದೆ.")}
              </p>
            </div>
            <span className="max-w-full self-start break-all rounded-full border border-line px-2.5 py-1 text-[10px] text-muted">
              {editing
                ? tr(`Editing case: ${form.CaseMasterID || persistedCaseId}`, `ಪ್ರಕರಣ ಸಂಪಾದಿಸಲಾಗುತ್ತಿದೆ: ${form.CaseMasterID || persistedCaseId}`)
                : persisted
                  ? tr("Local draft saved", "ಸ್ಥಳೀಯ ಕರಡು ಉಳಿಸಲಾಗಿದೆ")
                  : tr("New local draft", "ಹೊಸ ಸ್ಥಳೀಯ ಕರಡು")}
            </span>
          </div>

          <div className="grid lg:grid-cols-[1fr_auto] gap-3 mt-4 items-stretch">
            <textarea
              value={complaint}
              onChange={(event) => setComplaint(event.target.value)}
              rows={3}
              placeholder={tr("Describe what happened, who reported it, where and when...", "ಏನಾಯಿತು, ಯಾರು ವರದಿ ಮಾಡಿದರು, ಎಲ್ಲಿ ಮತ್ತು ಯಾವಾಗ ಎಂದು ವಿವರಿಸಿ...")}
              className="w-full resize-none bg-panel border border-line rounded-xl p-3 text-sm text-white placeholder-muted outline-none focus:border-brand/50"
            />
            <button
              type="button"
              onClick={generateDraft}
              disabled={!complaint.trim() || aiLoading}
              className="lg:w-48 rounded-xl bg-brand px-5 py-3 text-sm font-medium text-white disabled:opacity-40 transition hover:bg-brand/90"
            >
              {aiLoading ? tr("Analyzing text...", "ಪಠ್ಯ ವಿಶ್ಲೇಷಿಸಲಾಗುತ್ತಿದೆ...") : aiReady ? tr("Refresh Auto-Fill", "ಸ್ವಯಂ ಭರ್ತಿ ನವೀಕರಿಸಿ") : tr("Run Autonomous Fill", "ಸ್ವಯಂ ಭರ್ತಿ ಪ್ರಾರಂಭಿಸಿ")}
            </button>
          </div>

          {saveState.message && (
            <div
              className={`mt-3 rounded-lg border px-3 py-2 text-xs ${saveState.status === "error"
                  ? "border-amber/30 bg-amber/10 text-amber"
                  : "border-sage/30 bg-sage/10 text-sage"
                }`}
            >
              {saveState.message}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-col lg:flex-row">
        <aside className="w-full shrink-0 border-b border-line bg-ink px-4 py-4 lg:sticky lg:top-0 lg:w-72 lg:self-start lg:border-b-0 lg:border-r lg:px-6 lg:py-8">
          <div className="new-fir-steps flex gap-2 overflow-x-auto pb-2 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0">
            {STEPS.map((item) => {
              const active = step === item.id;
              const done = step > item.id;
              const locked = item.id > highestUnlocked;
              return (
                <button
                  key={item.id}
                  onClick={() => !locked && setStep(item.id)}
                  disabled={locked}
                  aria-current={active ? "step" : undefined}
                  className={`new-fir-step w-[min(76vw,17rem)] shrink-0 rounded-xl border px-3 py-3 text-left transition lg:w-full ${active
                      ? "bg-brand/10 border-brand/40"
                      : done
                        ? "border-sage/30 bg-sage/5 hover:bg-sage/10"
                        : "border-transparent hover:bg-panel"
                    } ${locked ? "opacity-45 cursor-not-allowed" : ""}`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`h-7 w-7 rounded-full grid place-items-center text-xs font-semibold shrink-0 ${active
                          ? "bg-brand text-white"
                          : done
                            ? "bg-sage/15 text-sage border border-sage/30"
                            : "bg-panel text-muted border border-line"
                        }`}
                    >
                      {done ? "OK" : item.id}
                    </div>
                    <div className="min-w-0">
                      <div className={`text-sm font-medium ${active ? "text-white" : "text-muted"}`}>
                        {tr(item.title, ["", "ಪ್ರಕರಣದ ಮೂಲ ವಿವರಗಳು", "ಘಟನೆಯ ವಿವರಗಳು", "ದೂರುದಾರ", "ಸಂತ್ರಸ್ತರು", "ಆರೋಪಿತರು", "ಕಾಯ್ದೆಗಳು ಮತ್ತು ಸೆಕ್ಷನ್‌ಗಳು", "ಪರಿಶೀಲಿಸಿ ಮತ್ತು ಸಲ್ಲಿಸಿ"][item.id])}
                      </div>
                      <div className="text-[11px] text-muted mt-0.5">{tr(item.subtitle, ["", "ಸಂಬಂಧಿತ ವಿವರಗಳನ್ನು ನಮೂದಿಸುವ ಮೊದಲು ಪ್ರಕರಣದ ಸಾಲನ್ನು ಉಳಿಸಿ", "ಸಂಗತಿಗಳು, ವರದಿ ದಿನಾಂಕ, ಘಟನೆ ಅವಧಿ ಮತ್ತು ಸ್ಥಳ", "ದೂರು ಸಲ್ಲಿಸಿದ ವ್ಯಕ್ತಿ ಅಥವಾ ಸಂಸ್ಥೆ", "ಸಂತ್ರಸ್ತರ ಹೆಸರುಗಳನ್ನು Consolidated_Cases ಸಾಲಿನಲ್ಲಿ ಸಂಗ್ರಹಿಸಲಾಗುತ್ತದೆ", "ಪ್ರಕರಣ ಅಸ್ತಿತ್ವದಲ್ಲಿದ್ದ ಬಳಿಕವೇ ಆರೋಪಿತರ ವಿವರಗಳು ತೆರೆಯುತ್ತವೆ", "ಕಾಯ್ದೆಗಳು, ಸೆಕ್ಷನ್‌ಗಳು, ಬಂಧನಗಳು ಮತ್ತು ಆರೋಪಪಟ್ಟಿ ಕ್ಷೇತ್ರಗಳು", "Google Sheets ಮಾಸ್ಟರ್ ನವೀಕರಿಸಲು ಒಮ್ಮೆ ಸಲ್ಲಿಸಿ"][item.id])}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-6 lg:min-h-[calc(100vh-4rem)] lg:px-8 lg:py-8">
          <div className="mx-auto w-full max-w-4xl">
            <div className="mb-5 flex flex-col gap-2 min-[480px]:flex-row min-[480px]:items-start min-[480px]:justify-between sm:mb-6">
              <div className="min-w-0">
                <h1 className="text-2xl font-schibsted text-white font-semibold">
                  {tr(meta.title, ["", "ಪ್ರಕರಣದ ಮೂಲ ವಿವರಗಳು", "ಘಟನೆಯ ವಿವರಗಳು", "ದೂರುದಾರ", "ಸಂತ್ರಸ್ತರು", "ಆರೋಪಿತರು", "ಕಾಯ್ದೆಗಳು ಮತ್ತು ಸೆಕ್ಷನ್‌ಗಳು", "ಪರಿಶೀಲಿಸಿ ಮತ್ತು ಸಲ್ಲಿಸಿ"][step])}
                </h1>
                <p className="text-muted text-sm mt-1">{tr(meta.subtitle, ["", "ಸಂಬಂಧಿತ ವಿವರಗಳನ್ನು ನಮೂದಿಸುವ ಮೊದಲು ಪ್ರಕರಣದ ಸಾಲನ್ನು ಉಳಿಸಿ", "ಸಂಗತಿಗಳು, ವರದಿ ದಿನಾಂಕ, ಘಟನೆ ಅವಧಿ ಮತ್ತು ಸ್ಥಳ", "ದೂರು ಸಲ್ಲಿಸಿದ ವ್ಯಕ್ತಿ ಅಥವಾ ಸಂಸ್ಥೆ", "ಸಂತ್ರಸ್ತರ ಹೆಸರುಗಳನ್ನು Consolidated_Cases ಸಾಲಿನಲ್ಲಿ ಸಂಗ್ರಹಿಸಲಾಗುತ್ತದೆ", "ಪ್ರಕರಣ ಅಸ್ತಿತ್ವದಲ್ಲಿದ್ದ ಬಳಿಕವೇ ಆರೋಪಿತರ ವಿವರಗಳು ತೆರೆಯುತ್ತವೆ", "ಕಾಯ್ದೆಗಳು, ಸೆಕ್ಷನ್‌ಗಳು, ಬಂಧನಗಳು ಮತ್ತು ಆರೋಪಪಟ್ಟಿ ಕ್ಷೇತ್ರಗಳು", "Google Sheets ಮಾಸ್ಟರ್ ನವೀಕರಿಸಲು ಒಮ್ಮೆ ಸಲ್ಲಿಸಿ"][step])}</p>
              </div>
              <div className="text-xs text-muted">
                {tr("Step", "ಹಂತ")} <span className="text-white font-semibold">{step}</span> {tr("of", "ರಲ್ಲಿ")} {STEPS.length}
              </div>
            </div>

            <div className="rounded-2xl border border-line bg-shell/40 p-4 sm:p-6">
              {step === 1 && (
                <Step1
                  form={form}
                  update={update}
                  options={options}
                  stationOptions={stationOptions}
                  crimeHeadOptions={crimeHeadOptions}
                  crimeSubHeadOptions={crimeSubHeadOptions}
                  refreshOptions={refreshOptions}
                />
              )}
              {step === 2 && <Step2 form={form} update={update} />}
              {step === 3 && <Step3 form={form} update={update} />}
              {step === 4 && <Step4 form={form} update={update} victimCount={victimCount} />}
              {step === 5 && (
                <Step5
                  form={form}
                  update={update}
                  disabled={false}
                  accusedCount={accusedCount}
                />
              )}
              {step === 6 && (
                <Step6
                  form={form}
                  update={update}
                  options={options}
                  refreshOptions={refreshOptions}
                />
              )}
              {step === 7 && <Step7 form={form} persisted={persisted} />}
            </div>

            <div className="mt-5 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button
                onClick={() => setStep((current) => Math.max(1, current - 1))}
                disabled={step === 1 || saveState.status === "saving"}
                className="self-start px-3 py-2 text-sm text-muted hover:text-white disabled:opacity-40"
              >
                {tr("← Previous", "← ಹಿಂದಿನದು")}
              </button>

              <div className="new-fir-actions grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center sm:gap-3">
                <button
                  onClick={fillDemoForStep}
                  disabled={saveState.status === "saving"}
                  className="h-10 rounded-lg border border-brand/40 px-3 text-sm text-brand hover:bg-brand/10 disabled:opacity-40 sm:px-4"
                >
                  {tr("Fill demo", "ಮಾದರಿ ತುಂಬಿಸಿ")}
                </button>

                <button
                  onClick={() => saveCurrentStep(false)}
                  disabled={saveState.status === "saving"}
                  className="h-10 rounded-lg border border-line px-3 text-sm text-muted hover:text-white disabled:opacity-40 sm:px-4"
                >
                  {saveState.status === "saving" ? tr("Saving...", "ಉಳಿಸಲಾಗುತ್ತಿದೆ...") : tr("Save draft", "ಕರಡು ಉಳಿಸಿ")}
                </button>

                {step < STEPS.length ? (
                  <button
                    onClick={goNext}
                    disabled={saveState.status === "saving"}
                    className="col-span-2 min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow-glow hover:bg-brand/90 disabled:opacity-40 sm:px-5"
                  >
                    {tr("Save draft & continue →", "ಕರಡು ಉಳಿಸಿ ಮತ್ತು ಮುಂದುವರಿಸಿ →")}
                  </button>
                ) : (
                  <button
                    onClick={submit}
                    disabled={saveState.status === "saving"}
                    className="col-span-2 min-h-10 rounded-lg bg-sage px-4 py-2 text-sm font-medium text-white hover:bg-sage/90 disabled:opacity-40 sm:px-5"
                  >
                    {tr("Submit FIR", "ಎಫ್‌ಐಆರ್ ಸಲ್ಲಿಸಿ")}
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      {successRoute && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-2xl border border-sage/40 bg-shell p-6 shadow-2xl">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-sage/15 text-sage border border-sage/30">
              OK
            </div>
            <h2 className="text-center text-xl font-semibold text-white">{tr("FIR successfully submitted", "ಎಫ್‌ಐಆರ್ ಯಶಸ್ವಿಯಾಗಿ ಸಲ್ಲಿಸಲಾಗಿದೆ")}</h2>
            <p className="mt-2 text-center text-sm text-muted">
              {tr("The FIR and its related details were saved to Google Sheets.", "ಎಫ್‌ಐಆರ್ ಮತ್ತು ಅದರ ಸಂಬಂಧಿತ ವಿವರಗಳನ್ನು Google Sheets ನಲ್ಲಿ ಉಳಿಸಲಾಗಿದೆ.")}
              {successNotice ? ` ${successNotice}` : ""}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={() => setShowQR(true)}
                className="h-10 rounded-lg border border-sage/50 text-sage hover:bg-sage/10 px-5 text-sm font-medium transition-colors"
              >
                {tr("Get Citizen Case Pass QR", "ಸಿಟಿಜನ್ ಕೇಸ್ ಪಾಸ್ QR ಪಡೆಯಿರಿ")}
              </button>
              <button
                type="button"
                onClick={() => navigate(successRoute)}
                className="h-10 rounded-lg bg-sage px-5 text-sm font-medium text-white hover:bg-sage/90 transition-colors"
              >
                {tr("View FIR", "ಎಫ್‌ಐಆರ್ ನೋಡಿ")}
              </button>
            </div>

            {showQR && <CasePassQR record={form} onClose={() => setShowQR(false)} />}
          </div>
        </div>
      )}
    </div>
  );
};

export default NewFIR;

const Step1: React.FC<{
  form: FormState;
  update: (field: string, value: string) => void;
  options: CaseOptions;
  stationOptions: string[];
  crimeHeadOptions: string[];
  crimeSubHeadOptions: string[];
  refreshOptions: () => void;
}> = ({
  form,
  update,
  options,
  stationOptions,
  crimeHeadOptions,
  crimeSubHeadOptions,
  refreshOptions,
}) => {
    const { language, tr } = useLanguage();
    return (
      <>
        <Section title="Case identity">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="CaseMasterID">
              <input
                value={form.CaseMasterID}
                onChange={(event) => update("CaseMasterID", event.target.value)}
                placeholder={tr("Enter random ID or auto-assign", "ಯಾದೃಚ್ಛಿಕ ಐಡಿ ನಮೂದಿಸಿ ಅಥವಾ ಸ್ವಯಂ ನಿಯೋಜಿಸಿ")}
                className={inputClass}
              />
            </Field>
            <Field label="CaseNo">
              <input
                value={form.CaseNo}
                onChange={(event) => update("CaseNo", event.target.value)}
                placeholder={tr("Enter random Case No", "ಯಾದೃಚ್ಛಿಕ ಪ್ರಕರಣ ಸಂಖ್ಯೆ ನಮೂದಿಸಿ")}
                className={inputClass}
              />
            </Field>
            <Field label="CrimeNo">
              <input
                value={form.CrimeNo}
                onChange={(event) => update("CrimeNo", event.target.value)}
                placeholder={tr("Enter random Crime No", "ಯಾದೃಚ್ಛಿಕ ಅಪರಾಧ ಸಂಖ್ಯೆ ನಮೂದಿಸಿ")}
                className={inputClass}
              />
            </Field>
          </div>
        </Section>

        <Section title="Case basics">
          <p className="mb-3 text-xs text-muted">
            {tr("Suggestions refresh from Google Sheets when a field is opened. Select a suggestion or type a new value.", "ಕ್ಷೇತ್ರವನ್ನು ತೆರೆದಾಗ Google Sheets ನಿಂದ ಸಲಹೆಗಳು ನವೀಕರಿಸುತ್ತವೆ. ಸಲಹೆಯನ್ನು ಆಯ್ಕೆ ಮಾಡಿ ಅಥವಾ ಹೊಸ ಮೌಲ್ಯವನ್ನು ಟೈಪ್ ಮಾಡಿ.")}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="CrimeRegisteredDate">
              <input
                type="date"
                value={form.CrimeRegisteredDate}
                onChange={(event) => update("CrimeRegisteredDate", event.target.value)}
                className={inputClass}
              />
            </Field>

            <Field label="PoliceStation">
              <select
                value={form.PoliceStation}
                onChange={(e) => update("PoliceStation", e.target.value)}
                className={inputClass}
                onFocus={refreshOptions}
              >
                <option value="">- {tr("Select Police Station", "ಪೊಲೀಸ್ ಠಾಣೆ ಆಯ್ಕೆ ಮಾಡಿ")} -</option>
                {stationOptions.map((s) => (
                  <option key={s} value={s}>{displayPlaceName(s, language)}</option>
                ))}
              </select>
            </Field>
            <OptionInput
              label="CrimeHead"
              field="CrimeHead"
              value={form.CrimeHead}
              onChange={(value) => {
                update("CrimeHead", value);
                update("CrimeSubHead", "");
              }}
              options={crimeHeadOptions}
              placeholder="Select or type crime head"
              onOptionsOpen={refreshOptions}
            />
            <OptionInput
              label="CrimeSubHead"
              field="CrimeSubHead"
              value={form.CrimeSubHead}
              onChange={(value) => update("CrimeSubHead", value)}
              options={crimeSubHeadOptions}
              placeholder="Select or type crime sub-head"
              onOptionsOpen={refreshOptions}
            />
            <OptionInput
              label="PoliceStationType"
              field="PoliceStationType"
              value={form.PoliceStationType}
              onChange={(value) => update("PoliceStationType", value)}
              options={optionList(options, "PoliceStationType")}
              onOptionsOpen={refreshOptions}
            />
            <OptionInput
              label="District"
              field="District"
              value={form.District}
              onChange={(value) => update("District", value)}
              options={optionList(options, "District")}
              onOptionsOpen={refreshOptions}
            />
            <OptionInput
              label="CaseCategory"
              field="CaseCategory"
              value={form.CaseCategory}
              onChange={(value) => update("CaseCategory", value)}
              options={optionList(options, "CaseCategory")}
              onOptionsOpen={refreshOptions}
            />
            <OptionInput
              label="Gravity"
              field="Gravity"
              value={form.Gravity}
              onChange={(value) => update("Gravity", value)}
              options={optionList(options, "Gravity")}
              onOptionsOpen={refreshOptions}
            />
            <OptionInput
              label="Status"
              field="Status"
              value={form.Status}
              onChange={(value) => update("Status", value)}
              options={optionList(options, "Status")}
              onOptionsOpen={refreshOptions}
            />
            <OptionInput
              label="Court"
              field="Court"
              value={form.Court}
              onChange={(value) => update("Court", value)}
              options={optionList(options, "Court")}
              placeholder="Select or type court"
              onOptionsOpen={refreshOptions}
            />
          </div>
        </Section>

        <Section title="Officer assignment">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="EmployeeID">
              <input
                value={form.EmployeeID}
                onChange={(event) => update("EmployeeID", event.target.value)}
                className={inputClass}
              />
            </Field>
            <OptionInput
              label="Officer"
              field="Officer"
              value={form.Officer}
              onChange={(value) => update("Officer", value)}
              options={optionList(options, "Officer")}
              onOptionsOpen={refreshOptions}
            />
            <OptionInput
              label="OfficerRank"
              field="OfficerRank"
              value={form.OfficerRank}
              onChange={(value) => update("OfficerRank", value)}
              options={optionList(options, "OfficerRank")}
              onOptionsOpen={refreshOptions}
            />
            <OptionInput
              label="OfficerDesignation"
              field="OfficerDesignation"
              value={form.OfficerDesignation}
              onChange={(value) => update("OfficerDesignation", value)}
              options={optionList(options, "OfficerDesignation")}
              onOptionsOpen={refreshOptions}
            />
          </div>
        </Section>
      </>
    );
  };

const Step2: React.FC<{ form: FormState; update: (field: string, value: string) => void }> = ({
  form,
  update,
}) => (
  <>
    <Field label="BriefFacts" hint="This maps directly to the BriefFacts column.">
      <textarea
        rows={6}
        value={form.BriefFacts}
        onChange={(event) => update("BriefFacts", event.target.value)}
        className={inputClass}
      />
    </Field>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
      <Field label="InfoReceivedPSDate">
        <input
          value={form.InfoReceivedPSDate}
          onChange={(event) => update("InfoReceivedPSDate", event.target.value)}
          placeholder="YYYY-MM-DD HH:MM:SS"
          className={inputClass}
        />
      </Field>
      <Field label="IncidentFromDate">
        <input
          value={form.IncidentFromDate}
          onChange={(event) => update("IncidentFromDate", event.target.value)}
          placeholder="YYYY-MM-DD HH:MM:SS"
          className={inputClass}
        />
      </Field>
      <Field label="IncidentToDate">
        <input
          value={form.IncidentToDate}
          onChange={(event) => update("IncidentToDate", event.target.value)}
          placeholder="YYYY-MM-DD HH:MM:SS"
          className={inputClass}
        />
      </Field>
      <Field label="Latitude">
        <input
          value={form.Latitude}
          onChange={(event) => update("Latitude", event.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label="Longitude">
        <input
          value={form.Longitude}
          onChange={(event) => update("Longitude", event.target.value)}
          className={inputClass}
        />
      </Field>
    </div>
  </>
);

const Step3: React.FC<{ form: FormState; update: (field: string, value: string) => void }> = ({
  form,
  update,
}) => (
  <Field label="Complainant" hint="Consolidated_Cases stores one complainant text value.">
    <input
      value={form.Complainant}
      onChange={(event) => update("Complainant", event.target.value)}
      className={inputClass}
    />
  </Field>
);

const Step4: React.FC<{
  form: FormState;
  update: (field: string, value: string) => void;
  victimCount: number;
}> = ({ form, update, victimCount }) => {
  const { tr } = useLanguage();
  return (
    <>
      <Field label="VictimNames" hint="Enter one victim per line. Press Enter for each new name. Spaces in names are fully supported.">
        <textarea
          rows={6}
          value={form.VictimNames.replace(/;\s*/g, '\n')}
          onChange={(e) => update("VictimNames", e.target.value)}
          className={inputClass}
        />
      </Field>
      <div className="text-xs text-muted mt-3">
        {tr("VictimCount will be saved as", "ಸಂತ್ರಸ್ತರ ಸಂಖ್ಯೆಯನ್ನು ಹೀಗೆ ಉಳಿಸಲಾಗುತ್ತದೆ")} <span className="text-white font-semibold">{victimCount}</span>.
      </div>
    </>
  );
};

const Step5: React.FC<{
  form: FormState;
  update: (field: string, value: string) => void;
  disabled: boolean;
  accusedCount: number;
}> = ({ form, update, disabled, accusedCount }) => {
  const { tr } = useLanguage();
  return (
    <>
      {disabled && (
        <div className="mb-4 rounded-lg border border-amber/30 bg-amber/10 text-amber text-sm px-4 py-3">
          {tr("Save Case Basics first. Accused details cannot be entered until the case row exists.", "ಮೊದಲು ಪ್ರಕರಣದ ಮೂಲ ವಿವರಗಳನ್ನು ಉಳಿಸಿ. ಪ್ರಕರಣದ ಸಾಲು ಅಸ್ತಿತ್ವದಲ್ಲಿರುವವರೆಗೆ ಆರೋಪಿತರ ವಿವರಗಳನ್ನು ನಮೂದಿಸಲು ಸಾಧ್ಯವಿಲ್ಲ.")}
        </div>
      )}
      <Field label="AccusedNames" hint="Enter one accused per line. Press Enter for each new name. Spaces in names are fully supported.">
        <textarea
          rows={6}
          value={form.AccusedNames.replace(/;\s*/g, '\n')}
          onChange={(e) => !disabled && update("AccusedNames", e.target.value)}
          className={inputClass}
          disabled={disabled}
        />
      </Field>
      <div className="text-xs text-muted mt-3">
        {tr("AccusedCount will be saved as", "ಆರೋಪಿತರ ಸಂಖ್ಯೆಯನ್ನು ಹೀಗೆ ಉಳಿಸಲಾಗುತ್ತದೆ")} <span className="text-white font-semibold">{accusedCount}</span>.
      </div>
    </>
  );
};

const Step6: React.FC<{
  form: FormState;
  update: (field: string, value: string) => void;
  options: CaseOptions;
  refreshOptions: () => void;
}> = ({ form, update, options, refreshOptions }) => {
  const { tr } = useLanguage();
  return (
    <>
      <p className="mb-4 text-xs text-muted">
        {tr("Suggestions refresh from Google Sheets when a field is opened. You can also type values and separate multiple entries with semicolons.", "ಕ್ಷೇತ್ರವನ್ನು ತೆರೆದಾಗ Google Sheets ನಿಂದ ಸಲಹೆಗಳು ನವೀಕರಿಸುತ್ತವೆ. ಮೌಲ್ಯಗಳನ್ನು ಟೈಪ್ ಮಾಡಬಹುದು ಮತ್ತು ಅನೇಕ ನಮೂದುಗಳನ್ನು ಅರ್ಧವಿರಾಮ ಚಿಹ್ನೆಯಿಂದ ಬೇರ್ಪಡಿಸಬಹುದು.")}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <OptionInput
          label="Acts"
          field="Acts"
          value={form.Acts}
          onChange={(value) => update("Acts", value)}
          options={optionList(options, "Acts")}
          placeholder="Select or type; separate multiple acts with semicolons"
          onOptionsOpen={refreshOptions}
        />
        <OptionInput
          label="Sections"
          field="Sections"
          value={form.Sections}
          onChange={(value) => update("Sections", value)}
          options={optionList(options, "Sections")}
          placeholder="Select or type; separate multiple sections with semicolons"
          onOptionsOpen={refreshOptions}
        />
        <Field label="ArrestCount">
          <input
            value={form.ArrestCount}
            onChange={(event) => update("ArrestCount", event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="ChargesheetCount">
          <input
            value={form.ChargesheetCount}
            onChange={(event) => update("ChargesheetCount", event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="LatestChargesheetDate">
          <input
            type="date"
            value={form.LatestChargesheetDate}
            onChange={(event) => update("LatestChargesheetDate", event.target.value)}
            className={inputClass}
          />
        </Field>
        <OptionInput
          label="ChargesheetStatus"
          field="ChargesheetStatus"
          value={form.ChargesheetStatus}
          onChange={(value) => update("ChargesheetStatus", value)}
          options={optionList(options, "ChargesheetStatus")}
          onOptionsOpen={refreshOptions}
        />
      </div>
    </>
  );
};

const Step7: React.FC<{ form: FormState; persisted: boolean }> = ({ form, persisted }) => {
  const { language, tr } = useLanguage();
  const summary = [
    ["CaseMasterID", form.CaseMasterID || tr("Assigned on save", "ಉಳಿಸುವಾಗ ನಿಯೋಜಿಸಲಾಗುತ್ತದೆ")],
    ["CaseNo", form.CaseNo || tr("Assigned on save", "ಉಳಿಸುವಾಗ ನಿಯೋಜಿಸಲಾಗುತ್ತದೆ")],
    ["CrimeNo", form.CrimeNo || tr("Assigned on save", "ಉಳಿಸುವಾಗ ನಿಯೋಜಿಸಲಾಗುತ್ತದೆ")],
    ["PoliceStation", displayPlaceName(form.PoliceStation, language)],
    ["CrimeHead", displayKnownValue(form.CrimeHead, language)],
    ["CrimeSubHead", displayKnownValue(form.CrimeSubHead, language)],
    ["Complainant", form.Complainant],
    ["VictimCount", String(splitNames(form.VictimNames).length)],
    ["AccusedCount", String(splitNames(form.AccusedNames).length)],
    ["Status", displayKnownValue(form.Status, language)],
  ];

  return (
    <>
      <p className="text-sm text-muted mb-4">
        {tr("Review the row before submission. Earlier steps are kept in this browser tab; Submit FIR writes to Google Sheets once.", "ಸಲ್ಲಿಸುವ ಮೊದಲು ಸಾಲನ್ನು ಪರಿಶೀಲಿಸಿ. ಹಿಂದಿನ ಹಂತಗಳು ಈ ಬ್ರೌಸರ್ ಟ್ಯಾಬ್‌ನಲ್ಲಿ ಉಳಿಯುತ್ತವೆ; ಎಫ್‌ಐಆರ್ ಸಲ್ಲಿಸಿದಾಗ Google Sheets ಗೆ ಒಮ್ಮೆ ಬರೆಯಲಾಗುತ್ತದೆ.")}
      </p>

      {!persisted && (
        <div className="mb-4 rounded-lg border border-amber/30 bg-amber/10 text-amber text-sm px-4 py-3">
          {tr("Case Basics have not been saved as a local draft yet.", "ಪ್ರಕರಣದ ಮೂಲ ವಿವರಗಳನ್ನು ಇನ್ನೂ ಸ್ಥಳೀಯ ಕರಡಾಗಿ ಉಳಿಸಲಾಗಿಲ್ಲ.")}
        </div>
      )}

      <div className="bg-panel border border-line rounded-lg divide-y divide-line">
        {summary.map(([label, value]) => (
          <div key={label} className="grid grid-cols-1 gap-1 px-4 py-2.5 sm:grid-cols-3 sm:gap-0">
            <div className="text-xs text-muted uppercase tracking-wide">{tr(label, newFirCopy(label))}</div>
            <div className="break-words text-sm text-white sm:col-span-2">{value || "-"}</div>
          </div>
        ))}
      </div>
    </>
  );
};
