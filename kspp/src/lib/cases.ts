import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type CaseRecord = Record<string, string>;

export type CaseOptions = {
  [field: string]: string[] | Record<string, string[]> | undefined;
  crimeSubHeadsByHead?: Record<string, string[]>;
};

export type CasesResponse = {
  ok: boolean;
  headers: string[];
  cases: CaseRecord[];
  options: CaseOptions;
  error?: string;
};

export type SyncResult = {
  ok: boolean;
  skipped?: boolean;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  message?: string;
};

export type CaseSaveResponse = {
  ok: boolean;
  created: boolean;
  headers: string[];
  case: CaseRecord;
  options: CaseOptions;
  sync: SyncResult;
  notifications?: {
    event: "new_fir" | "status_update";
    matched: number;
    eligible: number;
    sent: number;
    failed: number;
    systemError?: boolean;
  } | null;
  error?: string;
};

export type CasePullResponse = CasesResponse & {
  pull: SyncResult;
  writeResult?: {
    pending?: boolean;
    file?: string;
    error?: unknown;
  };
};

export type FirRecord = {
  id: string;
  label: string;
  fir: string;
  caseNo: string;
  category: string;
  station: string;
  io: string;
  status: string;
  gravity: string;
  date: string;
  complainant: string;
  accused: string;
  victims: string;
  section: string;
  raw: CaseRecord;
};

const api = (path: string) => `/api${path}`;

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    if (response.status === 401 && window.location.pathname !== "/session-expired") {
      window.location.assign("/session-expired");
    }
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }
  return data;
}

export async function fetchCases(): Promise<CasesResponse> {
  return readJson<CasesResponse>(await fetch(api("/cases"), { cache: "no-store" }));
}

export async function saveCase(
  record: CaseRecord,
  caseId?: string,
  options?: { skipSync?: boolean },
): Promise<CaseSaveResponse> {
  const response = await fetch(caseId ? api(`/cases/${encodeURIComponent(caseId)}`) : api("/cases"), {
    method: caseId ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ case: record, skipSync: Boolean(options?.skipSync) }),
  });
  return readJson<CaseSaveResponse>(response);
}

export async function runCaseSync(): Promise<{ ok: boolean; sync: SyncResult }> {
  const response = await fetch(api("/cases/sync"), { method: "POST" });
  return readJson<{ ok: boolean; sync: SyncResult }>(response);
}

export async function pullCasesFromMaster(): Promise<CasePullResponse> {
  const response = await fetch(api("/cases/pull"), { method: "POST" });
  return readJson<CasePullResponse>(response);
}

export function useCases() {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [options, setOptions] = useState<CaseOptions>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState("");
  const requestInFlight = useRef(false);

  const reload = useCallback(async (silent = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const data = await fetchCases();
      setCases(data.cases || []);
      setHeaders(data.headers || []);
      setOptions(data.options || {});
      setLastUpdatedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      requestInFlight.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void reload(true);
    };
    const interval = window.setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);

  return { cases, headers, options, loading, refreshing, lastUpdatedAt, error, reload, setCases, setOptions };
}

export function useFirRecords() {
  const caseState = useCases();
  const records = useMemo(() => caseState.cases.map(toFirRecord), [caseState.cases]);
  return { ...caseState, records };
}

export function caseKey(record: CaseRecord): string {
  return record.CaseMasterID || record.CaseNo || record.CrimeNo || "";
}

export function caseRoute(record: CaseRecord): string {
  return encodeURIComponent(caseKey(record));
}

export function caseLabel(record: CaseRecord): string {
  if (record.CaseNo) return `CR-${displayIdentifier(record.CaseNo)}`;
  if (record.CaseMasterID) return `Case ${displayIdentifier(record.CaseMasterID)}`;
  return displayIdentifier(record.CrimeNo) || "Unnumbered case";
}

/** Expand spreadsheet scientific notation without converting through Number. */
export function displayIdentifier(value: string | undefined): string {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const scientific = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!scientific) return raw.replace(/\.0+$/, "");

  const [, sign, integer, fraction = "", exponentText] = scientific;
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, "");
  const decimalIndex = integer.length + Number(exponentText);
  let expanded: string;
  if (decimalIndex <= 0) expanded = `0.${"0".repeat(-decimalIndex)}${digits}`;
  else if (decimalIndex >= digits.length) expanded = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  else expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;

  return `${sign === "-" ? "-" : ""}${expanded.replace(/\.0+$/, "")}`;
}

export function splitNames(value: string | undefined): string[] {
  return String(value || "")
    .split(/[;,\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinNames(values: string[]): string {
  return values.map((value) => value.trim()).filter(Boolean).join("; ");
}

export function dedupeOptionValues(values: string[]): string[] {
  const unique = new Map<string, string>();
  for (const rawValue of values) {
    const value = String(rawValue || "").trim().replace(/\s+/g, " ");
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, value);
  }
  return Array.from(unique.values()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

export type PatrolAlertResponse = {
  ok: boolean;
  notifications: {
    event: "patrol_alert";
    matched: number;
    eligible: number;
    sent: number;
    failed: number;
  };
  error?: string;
};

export async function sendPatrolAlert(input: {
  station: string;
  zone: string;
  risk: number;
  mode: string;
  peakWindow: string;
}): Promise<PatrolAlertResponse> {
  const response = await fetch(api("/patrol-alert"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<PatrolAlertResponse>(response);
}

export function optionList(options: CaseOptions, field: string): string[] {
  const value = options[field];
  return Array.isArray(value) ? dedupeOptionValues(value) : [];
}

export function subHeadOptions(options: CaseOptions, crimeHead: string): string[] {
  const byHead = options.crimeSubHeadsByHead;
  if (!byHead || !crimeHead.trim()) return optionList(options, "CrimeSubHead");

  const wanted = crimeHead.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const matchingHead = Object.keys(byHead).find(
    (head) => head.trim().replace(/\s+/g, " ").toLocaleLowerCase() === wanted,
  );
  return matchingHead
    ? dedupeOptionValues(byHead[matchingHead] || [])
    : optionList(options, "CrimeSubHead");
}

export function findCase(records: CaseRecord[], id: string | undefined): CaseRecord | undefined {
  const wanted = decodeURIComponent(id || "");
  return records.find(
    (record) =>
      record.CaseMasterID === wanted ||
      record.CaseNo === wanted ||
      record.CrimeNo === wanted,
  );
}

export function formatActSection(record: CaseRecord): string {
  const acts = splitNames(record.Acts);
  const sections = splitNames(record.Sections);
  if (acts.length === 0 && sections.length === 0) return "";
  if (acts.length === 1 && sections.length > 0) return `${acts[0]} ${sections.join(", ")}`;
  if (acts.length > 0 && sections.length > 0) return `${acts.join(", ")} | ${sections.join(", ")}`;
  return [...acts, ...sections].join(", ");
}

export function toFirRecord(record: CaseRecord): FirRecord {
  return {
    id: caseKey(record),
    label: caseLabel(record),
    fir: displayIdentifier(record.CrimeNo || record.CaseNo),
    caseNo: displayIdentifier(record.CaseNo),
    category: record.CrimeSubHead || record.CrimeHead || record.CaseCategory || "Case",
    station: record.PoliceStation || "",
    io: record.Officer || "",
    status: record.Status || "",
    gravity: record.Gravity || "",
    date: record.CrimeRegisteredDate || "",
    complainant: record.Complainant || "",
    accused: record.AccusedNames || "Unknown",
    victims: record.VictimNames || "",
    section: formatActSection(record),
    raw: record,
  };
}

export function searchText(record: FirRecord | CaseRecord): string {
  if ("raw" in record) {
    return Object.values(record.raw).join(" ").toLowerCase();
  }
  return Object.values(record).join(" ").toLowerCase();
}

export function countWhere(records: FirRecord[], predicate: (record: FirRecord) => boolean): number {
  return records.reduce((total, record) => total + (predicate(record) ? 1 : 0), 0);
}

export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
