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
import { KSPPBrandMark } from "../components/brand/KSPPBrand";

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

const Section: React.FC<{ title?: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <div className="mb-5">
    {title && (
      <div className="text-xs text-muted mb-2 uppercase tracking-wide">
        {title}
      </div>
    )}
    {children}
  </div>
);

const Field: React.FC<{
  label: string;
  children: React.ReactNode;
  hint?: string;
}> = ({ label, children, hint }) => (
  <label className="block">
    <span className="block text-xs text-muted mb-1.5">{label}</span>
    {children}
    {hint && <span className="block text-[11px] text-muted mt-1">{hint}</span>}
  </label>
);

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
          placeholder={placeholder || "Select or type"}
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
) => {
  if (!notifications) return "";
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
) => {
  if (sync.ok) {
    return sync.skipped
      ? "Local draft saved. Google Sheets will update once you click Submit FIR."
      : `FIR submitted. Google Sheets master was updated.${notificationMessage(notifications)}`;
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
  const { tr } = useLanguage();
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
        message: "CrimeRegisteredDate, PoliceStation, and CrimeHead are required before the case row can be saved.",
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
          message: "Draft saved in this browser tab. Submit FIR to update Google Sheets.",
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
          message: "This browser could not save the draft. Keep this page open and try again.",
        });
        return null;
      }
    }

    setSaveState({
      status: "saving",
      message: "Submitting FIR and updating Google Sheets...",
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
        message: syncMessage(result.sync, result.notifications),
      });
      await reload();
      return result;
    } catch (error) {
      setSaveState({
        status: "error",
        message:
          error instanceof Error
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
      setSuccessNotice(notificationMessage(result.notifications).trim());
      setSuccessRoute(`/fir/${caseRoute(result.case)}`);
    }
  };

  const generateDraft = async () => {
    if (!complaint.trim()) return;
    setAiLoading(true);
    setSaveState({ status: "idle", message: "" });
    
    try {
      // 🚀 Generate realistic random IDs as fallback for IDs if text does not provide them
      const liveOptionRules = [
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
      ]
        .map((field) => {
          const values = optionList(options, field);
          return values.length
            ? `- "${field}": prefer one of the current Google Sheets values ${JSON.stringify(values)}; use a new value only when the complaint explicitly requires it.`
            : `- "${field}": Google Sheets has no existing values yet; infer a concise value from the complaint.`;
        })
        .join("\n");

      // 🚀 Explicit FIR signal prefix included for backend detection
      const systemPrompt = `Extract FIR details into JSON format:
Analyze this police complaint text and extract structural parameters for ALL system fields across all 7 steps.
You MUST respond ONLY with a raw JSON object. Do not include any introductory text, no conversational explanations, no markdown formatting, and NO backticks (\`\`\`).

Live Google Sheets suggestion rules:
${liveOptionRules}

Expected JSON Structure:
{
  "CaseMasterID": "Extracted string ID or empty string if not mentioned",
  "CaseNo": "Extracted Case/FIR Number or empty string",
  "CrimeNo": "Extracted Crime Number or empty string",
  "CrimeRegisteredDate": "YYYY-MM-DD or empty string",
  "PoliceStation": "Selected from allowed list",
  "PoliceStationType": "Selected from allowed list",
  "District": "Selected from allowed list",
  "CrimeHead": "Selected from allowed list",
  "CrimeSubHead": "Selected from allowed list",
  "CaseCategory": "Selected from allowed list",
  "Gravity": "Selected from allowed list",
  "Status": "Selected from allowed list",
  "Court": "Name of local jurisdiction court",
  "EmployeeID": "Officer Employee ID if mentioned",
  "Officer": "Officer Name",
  "OfficerRank": "Rank if mentioned (e.g., Inspector of Police)",
  "OfficerDesignation": "Designation (e.g., Investigating Officer (IO))",
  "BriefFacts": "Detailed summary narrative of the complaint facts",
  "InfoReceivedPSDate": "YYYY-MM-DD HH:MM:SS date-time string",
  "IncidentFromDate": "YYYY-MM-DD HH:MM:SS date-time string",
  "IncidentToDate": "YYYY-MM-DD HH:MM:SS date-time string",
  "Latitude": "GPS latitude string if inferred or available",
  "Longitude": "GPS longitude string if inferred or available",
  "Complainant": "Full Name of person reporting",
  "VictimNames": "Semicolon separated list of victims",
  "AccusedNames": "Semicolon separated list of accused names or 'Unknown'",
  "Acts": "Applicable laws like BNS, IT Act",
  "Sections": "Specific law sections if referenced",
  "ArrestCount": "Number of arrests as string",
  "ChargesheetCount": "Number of chargesheets as string",
  "ChargesheetStatus": "Pending or Submitted"
}

Text to parse: "${complaint}"`;

      const parsedData = await requestFirDraft(complaint);

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

        // Step 5: Accused
        AccusedNames: parsedData.AccusedNames || current.AccusedNames,

        // Step 6: Acts & Sections
        Acts: parsedData.Acts || current.Acts,
        Sections: parsedData.Sections || current.Sections,
        ArrestCount: parsedData.ArrestCount || current.ArrestCount || "0",
        ChargesheetCount: parsedData.ChargesheetCount || current.ChargesheetCount || "0",
        ChargesheetStatus: parsedData.ChargesheetStatus || current.ChargesheetStatus || "Pending",
      }));

      setAiReady(true);
      setSaveState({ 
        status: "saved", 
        message: "AI Assistant extracted the available details. Review every field before saving or submitting."
      });
    } catch (err: any) {
      console.error("[Autonomous Auto-Fill Failure]:", err);
      setSaveState({ 
        status: "error", 
        message: `AI Draft extraction error: ${err.message || "Failed to parse JSON format"}. Please review fields manually.`
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
    return <div className="p-6 text-sm text-muted">Loading case from Google Sheets...</div>;
  }
 
  if (error && editing && !existingCase) {
    return <div className="p-6 text-sm text-rose">{error}</div>;
  }
  if (editing && !loading && !existingCase) {
    return <div className="p-6 text-sm text-muted">Case not found in Google Sheets master.</div>;
  }

  return (
    <div className="new-fir-page min-h-full overflow-x-hidden bg-ink text-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-ink px-4 py-3 sm:px-6">
        <h2 className="text-white text-sm font-medium">
          {editing ? "Edit FIR" : "New FIR"}
        </h2>
        <div className="text-[11px] text-muted sm:text-xs">
          Options: <span className="text-white">Live from Google Sheets</span>
        </div>
      </div>

      <div className="px-4 pt-4 sm:px-6 sm:pt-6">
        <div className="mx-auto max-w-6xl rounded-2xl border border-line bg-shell p-4 sm:p-5">
          <div className="flex flex-col gap-3 min-[600px]:flex-row min-[600px]:items-start min-[600px]:justify-between">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-white">
                {tr("AI FIR Draft Assistant", "AI FIR Draft Assistant")}
              </h1>
              <p className="text-xs text-muted mt-1">
                Enter a complaint draft and review each step. Drafts stay in this browser tab; Submit FIR updates Google Sheets once.
              </p>
            </div>
            <span className="max-w-full self-start break-all rounded-full border border-line px-2.5 py-1 text-[10px] text-muted">
              {editing
                ? `Editing case: ${form.CaseMasterID || persistedCaseId}`
                : persisted
                  ? "Local draft saved"
                  : "New local draft"}
            </span>
          </div>

          <div className="grid lg:grid-cols-[1fr_auto] gap-3 mt-4 items-stretch">
            <textarea
              value={complaint}
              onChange={(event) => setComplaint(event.target.value)}
              rows={3}
              placeholder="Describe what happened, who reported it, where and when..."
              className="w-full resize-none bg-panel border border-line rounded-xl p-3 text-sm text-white placeholder-muted outline-none focus:border-brand/50"
            />
           <button
            type="button"
            onClick={generateDraft}
            disabled={!complaint.trim() || aiLoading}
            className="lg:w-48 rounded-xl bg-brand px-5 py-3 text-sm font-medium text-white disabled:opacity-40 transition hover:bg-brand/90"
            >
            {aiLoading ? "Analyzing text..." : aiReady ? "Refresh Auto-Fill" : "Run Autonomous Fill"}
          </button>
          </div>

          {saveState.message && (
            <div
              className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                saveState.status === "error"
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
                  className={`new-fir-step w-[min(76vw,17rem)] shrink-0 rounded-xl border px-3 py-3 text-left transition lg:w-full ${
                    active
                      ? "bg-brand/10 border-brand/40"
                      : done
                      ? "border-sage/30 bg-sage/5 hover:bg-sage/10"
                      : "border-transparent hover:bg-panel"
                  } ${locked ? "opacity-45 cursor-not-allowed" : ""}`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`h-7 w-7 rounded-full grid place-items-center text-xs font-semibold shrink-0 ${
                        active
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
                        {item.title}
                      </div>
                      <div className="text-[11px] text-muted mt-0.5">{item.subtitle}</div>
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
                  {meta.title}
                </h1>
                <p className="text-muted text-sm mt-1">{meta.subtitle}</p>
              </div>
              <div className="text-xs text-muted">
                Step <span className="text-white font-semibold">{step}</span> of {STEPS.length}
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
                &lt;- Previous
              </button>

               <div className="new-fir-actions grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center sm:gap-3">
                <button
                  onClick={fillDemoForStep}
                  disabled={saveState.status === "saving"}
                   className="h-10 rounded-lg border border-brand/40 px-3 text-sm text-brand hover:bg-brand/10 disabled:opacity-40 sm:px-4"
                >
                  Fill demo
                </button>

                <button
                  onClick={() => saveCurrentStep(false)}
                  disabled={saveState.status === "saving"}
                   className="h-10 rounded-lg border border-line px-3 text-sm text-muted hover:text-white disabled:opacity-40 sm:px-4"
                >
                  {saveState.status === "saving" ? "Saving..." : "Save draft"}
                </button>

                {step < STEPS.length ? (
                  <button
                    onClick={goNext}
                    disabled={saveState.status === "saving"}
                     className="col-span-2 min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white shadow-glow hover:bg-brand/90 disabled:opacity-40 sm:px-5"
                  >
                    Save draft & continue -&gt;
                  </button>
                ) : (
                  <button
                    onClick={submit}
                    disabled={saveState.status === "saving"}
                     className="col-span-2 min-h-10 rounded-lg bg-sage px-4 py-2 text-sm font-medium text-white hover:bg-sage/90 disabled:opacity-40 sm:px-5"
                  >
                    Submit FIR
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
            <h2 className="text-center text-xl font-semibold text-white">FIR successfully submitted</h2>
            <p className="mt-2 text-center text-sm text-muted">
              The FIR and its related details were saved to Google Sheets.
              {successNotice ? ` ${successNotice}` : ""}
            </p>
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                onClick={() => navigate(successRoute)}
                className="h-10 rounded-lg bg-sage px-5 text-sm font-medium text-white hover:bg-sage/90"
              >
                View FIR
              </button>
            </div>
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
}) => (
  <>
    <Section title="Case identity">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="CaseMasterID">
          <input 
            value={form.CaseMasterID} 
            onChange={(event) => update("CaseMasterID", event.target.value)} 
            placeholder="Enter random ID or auto-assign" 
            className={inputClass} 
          />
        </Field>
        <Field label="CaseNo">
          <input
            value={form.CaseNo}
            onChange={(event) => update("CaseNo", event.target.value)}
            placeholder="Enter random Case No"
            className={inputClass}
          />
        </Field>
        <Field label="CrimeNo">
          <input
            value={form.CrimeNo}
            onChange={(event) => update("CrimeNo", event.target.value)}
            placeholder="Enter random Crime No"
            className={inputClass}
          />
        </Field>
      </div>
    </Section>

    <Section title="Case basics">
      <p className="mb-3 text-xs text-muted">
        Suggestions refresh from Google Sheets when a field is opened. Select a suggestion or type a new value.
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

        <OptionInput
          label="PoliceStation"
          field="PoliceStation"
          value={form.PoliceStation}
          onChange={(value) => update("PoliceStation", value)}
          options={stationOptions}
          placeholder="Select or type station"
          onOptionsOpen={refreshOptions}
        />
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
}> = ({ form, update, victimCount }) => (
  <>
    <Field label="VictimNames" hint="Enter one victim per line.">
      <textarea
        rows={6}
        value={textareaFromNames(form.VictimNames)}
        onChange={(event) => update("VictimNames", namesFromTextarea(event.target.value))}
        className={inputClass}
      />
    </Field>
    <div className="text-xs text-muted mt-3">
      VictimCount will be saved as <span className="text-white font-semibold">{victimCount}</span>.
    </div>
  </>
);

const Step5: React.FC<{
  form: FormState;
  update: (field: string, value: string) => void;
  disabled: boolean;
  accusedCount: number;
}> = ({ form, update, disabled, accusedCount }) => (
  <>
    {disabled && (
      <div className="mb-4 rounded-lg border border-amber/30 bg-amber/10 text-amber text-sm px-4 py-3">
        Save Case Basics first. Accused details cannot be entered until the case row exists.
      </div>
    )}
    <Field label="AccusedNames" hint="Enter one accused per line. Unknown accused can be entered as Unknown.">
      <textarea
        rows={6}
        value={textareaFromNames(form.AccusedNames)}
        onChange={(event) => update("AccusedNames", namesFromTextarea(event.target.value))}
        className={inputClass}
        disabled={disabled}
      />
    </Field>
    <div className="text-xs text-muted mt-3">
      AccusedCount will be saved as <span className="text-white font-semibold">{accusedCount}</span>.
    </div>
  </>
);

const Step6: React.FC<{
  form: FormState;
  update: (field: string, value: string) => void;
  options: CaseOptions;
  refreshOptions: () => void;
}> = ({ form, update, options, refreshOptions }) => (
  <>
    <p className="mb-4 text-xs text-muted">
      Suggestions refresh from Google Sheets when a field is opened. You can also type values and separate multiple entries with semicolons.
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

const Step7: React.FC<{ form: FormState; persisted: boolean }> = ({ form, persisted }) => {
  const summary = [
    ["CaseMasterID", form.CaseMasterID || "Assigned on save"],
    ["CaseNo", form.CaseNo || "Assigned on save"],
    ["CrimeNo", form.CrimeNo || "Assigned on save"],
    ["PoliceStation", form.PoliceStation],
    ["CrimeHead", form.CrimeHead],
    ["CrimeSubHead", form.CrimeSubHead],
    ["Complainant", form.Complainant],
    ["VictimCount", String(splitNames(form.VictimNames).length)],
    ["AccusedCount", String(splitNames(form.AccusedNames).length)],
    ["Status", form.Status],
  ];

  return (
    <>
      <p className="text-sm text-muted mb-4">
        Review the row before submission. Earlier steps are kept in this browser tab; Submit FIR writes to Google Sheets once.
      </p>

      {!persisted && (
        <div className="mb-4 rounded-lg border border-amber/30 bg-amber/10 text-amber text-sm px-4 py-3">
          Case Basics have not been saved as a local draft yet.
        </div>
      )}

      <div className="bg-panel border border-line rounded-lg divide-y divide-line">
        {summary.map(([label, value]) => (
          <div key={label} className="grid grid-cols-1 gap-1 px-4 py-2.5 sm:grid-cols-3 sm:gap-0">
            <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
            <div className="break-words text-sm text-white sm:col-span-2">{value || "-"}</div>
          </div>
        ))}
      </div>
    </>
  );
};
