/**
 * taskEngine.ts — Auto-generated task engine for the KSPP Officer To-Do List.
 *
 * Pure functions only. No React, no API calls, no side-effects.
 * Tasks are re-derived fresh from FIR data every time generateTasksForOfficer()
 * is called — they are never persisted to any store.
 *
 * Rule reference:
 *   R1 — Investigate:     status === "Under Investigation"
 *   R2 — Court:           CourtDate within 7 days  (opt-in field — add "CourtDate"
 *                         column to your Google Sheet to enable this rule)
 *   R3 — Stalled:         daysSince(CrimeRegisteredDate) > 30 and not closed
 *   R4 — Chargesheet:     CrPC deadline (90d heinous / 60d non-heinous from
 *                         CrimeRegisteredDate) within 5 days, chargesheet not filed
 */

import { splitNames, type FirRecord, type CaseRecord } from "./cases";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskPriority = "low" | "medium" | "high" | "critical";
export type TaskCategory = "investigation" | "court" | "followup" | "chargesheet";

export type GeneratedTask = {
  /** Stable ID derived from FIR number + rule — never random. */
  id: string;
  title: string;
  priority: TaskPriority;
  /** Human-readable context shown below the title, e.g. "Court in 2 days". */
  dueContext: string;
  /** The FIR number (CrimeNo or CaseMasterID) this task is linked to. */
  linkedFirNumber: string;
  /** Display-safe FIR number; expands scientific notation without changing the route key. */
  displayFirNumber: string;
  category: TaskCategory;
  /** ISO date string used for sorting; may be undefined if no deadline applies. */
  dueDate?: string;
};

/** Summary object consumed by stat tiles and the morning digest modal. */
export type GeneratedTaskStats = {
  total: number;
  critical: number;
  high: number;
  /** Unique tasks that are critical or overdue. */
  urgent: number;
  /** Tasks whose dueDate has already passed today. */
  overdue: number;
  /** Tasks due within 7 days (including today). */
  dueSoon: number;
  /** Court-category tasks due within 7 calendar days. */
  courtThisWeek: number;
  /** The single highest-priority task (first after priority sort). */
  topTask: GeneratedTask | null;
};

/** Localizes generated task copy at render time without changing persisted data. */
export function displayGeneratedTaskTitle(task: GeneratedTask, language: "en" | "kn") {
  if (language !== "kn") return task.title;
  const fir = `ಎಫ್‌ಐಆರ್ ${task.displayFirNumber}`;
  if (task.category === "investigation") return `${fir} ತನಿಖೆ ಮಾಡಿ`;
  if (task.category === "court") return `${fir} ನ್ಯಾಯಾಲಯ ಹಾಜರಾತಿಗೆ ಸಿದ್ಧತೆ ಮಾಡಿ`;
  if (task.category === "followup") return `${fir} ಸ್ಥಗಿತಗೊಂಡ ತನಿಖೆಯನ್ನು ಅನುಸರಿಸಿ`;
  return `${fir} ಆರೋಪಪಟ್ಟಿ ಸಲ್ಲಿಸಿ`;
}

export function displayGeneratedTaskContext(task: GeneratedTask, language: "en" | "kn") {
  if (language !== "kn") return task.dueContext;
  const numbers = task.dueContext.match(/\d+/g) || [];
  if (task.category === "investigation") return "ಸ್ಥಿತಿ: ತನಿಖೆಯಲ್ಲಿದೆ";
  if (task.category === "court") {
    if (/TODAY/i.test(task.dueContext)) return "ನ್ಯಾಯಾಲಯದ ದಿನಾಂಕ ಇಂದು — ತಕ್ಷಣದ ಕ್ರಮ ಅಗತ್ಯ";
    if (/TOMORROW/i.test(task.dueContext)) return "ನ್ಯಾಯಾಲಯ ಹಾಜರಾತಿ ನಾಳೆ";
    if (/was/i.test(task.dueContext)) return `ನ್ಯಾಯಾಲಯದ ದಿನಾಂಕ ${numbers[0] || 0} ದಿನಗಳ ಹಿಂದೆ ಇತ್ತು — ತಕ್ಷಣ ಅನುಸರಿಸಿ`;
    return `${numbers[0] || 0} ದಿನಗಳಲ್ಲಿ ನ್ಯಾಯಾಲಯ ಹಾಜರಾತಿ`;
  }
  if (task.category === "followup") return `${numbers[0] || 0} ದಿನಗಳ ಹಿಂದೆ ಸಲ್ಲಿಸಲಾಗಿದೆ — ಇನ್ನೂ ತೆರೆದಿದೆ`;
  if (/OVERDUE/i.test(task.dueContext)) return `ಆರೋಪಪಟ್ಟಿ ${numbers[0] || 0} ದಿನ ವಿಳಂಬವಾಗಿದೆ — CrPC ಸೆ.167 ಉಲ್ಲಂಘನೆ`;
  if (/TODAY/i.test(task.dueContext)) return `ಆರೋಪಪಟ್ಟಿ ಇಂದು ಸಲ್ಲಿಸಬೇಕು (${numbers[0] || 0} ದಿನಗಳ CrPC ಮಿತಿ)`;
  return `${numbers[0] || 0} ದಿನಗಳಲ್ಲಿ ಆರೋಪಪಟ್ಟಿ ಸಲ್ಲಿಸಬೇಕು — ${numbers[1] || 0} ದಿನಗಳ CrPC ಮಿತಿ`;
}

// ─── Date Utilities ───────────────────────────────────────────────────────────

/** Returns today as a local-timezone YYYY-MM-DD string. */
export function localIsoDate(d: Date = new Date()): string {
  // Use "sv" locale because it formats as YYYY-MM-DD in all browsers.
  return d.toLocaleDateString("sv");
}

/**
 * Days elapsed since a given ISO-like date string, measured in whole days
 * using local timezone boundaries. Returns NaN if the date is invalid.
 */
export function daysSince(dateStr: string, today: Date = new Date()): number {
  if (!dateStr) return NaN;
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return NaN;
  // Compare only date parts (no time component) to avoid timezone drift.
  const todayMidnight = new Date(localIsoDate(today));
  const parsedMidnight = new Date(localIsoDate(parsed));
  return Math.round(
    (todayMidnight.getTime() - parsedMidnight.getTime()) / (1000 * 60 * 60 * 24)
  );
}

/**
 * Days remaining until a future date. Positive = future, 0 = today, negative = past.
 */
export function daysUntil(dateStr: string, today: Date = new Date()): number {
  return -daysSince(dateStr, today);
}

/** Add `n` days to a date and return as YYYY-MM-DD string. */
function addDays(date: Date, n: number): string {
  const result = new Date(date);
  result.setDate(result.getDate() + n);
  return localIsoDate(result);
}

// ─── Rule Helpers ─────────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function makeId(firNumber: string, rule: string): string {
  // Sanitise so the ID is safe for use as a React key.
  const safe = String(firNumber || "unknown").replace(/[^a-zA-Z0-9]/g, "_");
  return `fir_${safe}_${rule}`;
}

function firLabel(fir: FirRecord): string {
  return fir.fir || fir.caseNo || fir.id || "Unknown";
}

export function displayIdentifier(value: string): string {
  const text = String(value || "").trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) return text;
  const [, sign, whole, fraction = "", exponentText] = match;
  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + Number(exponentText);
  if (!Number.isFinite(decimalIndex)) return text;
  if (decimalIndex <= 0) return `${sign}0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

const CLOSED_STATUSES = [
  "closed",
  "charge-sheeted",
  "chargesheeted",
  "solved",
  "undetected",
  "un-traced",
  "untraced",
  "final report",
];

function isClosed(status: string): boolean {
  const s = status.toLowerCase().trim();
  return CLOSED_STATUSES.some((c) => s.includes(c));
}

// ─── Four Rules ───────────────────────────────────────────────────────────────

/**
 * R1 — Investigate
 * Fires when status is "Under Investigation".
 */
function ruleInvestigate(fir: FirRecord): GeneratedTask | null {
  if ((fir.status || "").toLowerCase().trim() !== "under investigation") return null;
  const num = firLabel(fir);
  const displayNum = displayIdentifier(num);
  return {
    id: makeId(num, "investigate"),
    title: `Investigate FIR ${displayNum}`,
    priority: "medium",
    dueContext: `Status: Under Investigation · ${fir.category || "Case"}`,
    linkedFirNumber: num,
    displayFirNumber: displayNum,
    category: "investigation",
  };
}

/**
 * R2 — Court Appearance
 * Fires when raw["CourtDate"] is within 7 days.
 * CourtDate is an opt-in column — add it to your Google Sheet to enable this rule.
 * Priority escalates to "critical" if within 2 days.
 */
function ruleCourt(fir: FirRecord, today: Date): GeneratedTask | null {
  const courtDateStr = (fir.raw as CaseRecord & { CourtDate?: string })["CourtDate"];
  if (!courtDateStr) return null;

  const remaining = daysUntil(courtDateStr, today);
  if (remaining > 7 || isNaN(remaining)) return null;

  const num = firLabel(fir);
  const displayNum = displayIdentifier(num);
  const priority: TaskPriority = remaining <= 2 ? "critical" : "high";
  const dueContext =
    remaining < 0
      ? `Court date was ${Math.abs(remaining)} day(s) ago — follow up immediately`
      : remaining === 0
      ? "Court date is TODAY — immediate action required"
      : remaining === 1
      ? "Court appearance TOMORROW"
      : `Court appearance in ${remaining} days`;

  return {
    id: makeId(num, "court"),
    title: `Prepare for court appearance — FIR ${displayNum}`,
    priority,
    dueContext,
    linkedFirNumber: num,
    displayFirNumber: displayNum,
    category: "court",
    dueDate: courtDateStr,
  };
}

/**
 * R3 — Stalled Investigation Follow-Up
 * Fires when CrimeRegisteredDate is > 30 days ago and the case is not closed.
 */
function ruleStalled(fir: FirRecord, today: Date): GeneratedTask | null {
  if (isClosed(fir.status)) return null;
  const since = daysSince(fir.date, today);
  if (isNaN(since) || since <= 30) return null;

  const num = firLabel(fir);
  const displayNum = displayIdentifier(num);
  return {
    id: makeId(num, "stalled"),
    title: `Follow up on stalled investigation — FIR ${displayNum}`,
    priority: "high",
    dueContext: `Filed ${since} days ago — still open (${fir.status})`,
    linkedFirNumber: num,
    displayFirNumber: displayNum,
    category: "followup",
  };
}

/**
 * R4 — Chargesheet Deadline
 * CrPC S.167: 90 days for heinous offences, 60 days for non-heinous.
 * Fires when the deadline is within 5 days and ChargesheetStatus !== "Filed".
 */
function ruleChargesheet(fir: FirRecord, today: Date): GeneratedTask | null {
  // Skip if chargesheet already filed.
  const csStatus = String(
    (fir.raw as CaseRecord)["ChargesheetStatus"] || ""
  ).toLowerCase();
  if (csStatus === "filed") return null;
  // Skip closed cases.
  if (isClosed(fir.status)) return null;

  if (!fir.date) return null;

  const isHeinous =
    String((fir.raw as CaseRecord)["Gravity"] || fir.gravity || "")
      .toLowerCase()
      .includes("heinous");
  const limitDays = isHeinous ? 90 : 60;

  const deadlineIso = addDays(new Date(fir.date), limitDays);
  const remaining = daysUntil(deadlineIso, today);

  if (remaining > 5 || isNaN(remaining)) return null;

  const num = firLabel(fir);
  const displayNum = displayIdentifier(num);
  const priority: TaskPriority = "critical";
  const dueContext =
    remaining < 0
      ? `Chargesheet OVERDUE by ${Math.abs(remaining)} day(s) — CrPC S.167 breach`
      : remaining === 0
      ? `Chargesheet due TODAY (${limitDays}-day CrPC limit)`
      : `Chargesheet due in ${remaining} day(s) — ${limitDays}-day CrPC limit`;

  return {
    id: makeId(num, "chargesheet"),
    title: `File chargesheet — FIR ${displayNum}`,
    priority,
    dueContext,
    linkedFirNumber: num,
    displayFirNumber: displayNum,
    category: "chargesheet",
    dueDate: deadlineIso,
  };
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Derives tasks for a single officer from the full list of FIR records.
 *
 * @param officerName  The officer's display name (from `user.name`).
 *                     Matching is case-insensitive and trims whitespace.
 * @param allFirs      All FIR records fetched by useFirRecords().
 * @param today        Current date (injected for testability; default: new Date()).
 * @returns            Stable, sorted list of generated tasks. Always fresh —
 *                     call this every render; never cache the result.
 */
export function generateTasksForOfficer(
  officerName: string,
  allFirs: FirRecord[],
  today: Date = new Date()
): GeneratedTask[] {
  const name = officerName.trim().toLowerCase();

  // Filter to FIRs assigned to this officer (field: fir.io which maps to CaseRecord.Officer).
  const myFirs = allFirs.filter((fir) =>
    splitNames(fir.io).some((officer) => officer.toLowerCase() === name),
  );

  const seen = new Set<string>();
  const tasks: GeneratedTask[] = [];

  for (const fir of myFirs) {
    const candidates = [
      ruleInvestigate(fir),
      ruleCourt(fir, today),
      ruleStalled(fir, today),
      ruleChargesheet(fir, today),
    ];

    for (const task of candidates) {
      if (!task) continue;
      if (seen.has(task.id)) continue; // Dedupe (same FIR shouldn't generate duplicate ids)
      seen.add(task.id);
      tasks.push(task);
    }
  }

  // Sort: priority descending, then by dueDate ascending, then alphabetically.
  tasks.sort((a, b) => {
    const priDiff = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
    if (priDiff !== 0) return priDiff;
    if (a.dueDate && b.dueDate)
      return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return a.title.localeCompare(b.title);
  });

  return tasks;
}

/**
 * Computes summary stats from a list of generated tasks.
 * Mirrors the shape of TodoStats so existing stat tile components can consume it.
 */
export function computeGeneratedStats(
  tasks: GeneratedTask[],
  today: Date = new Date()
): GeneratedTaskStats {
  const todayIso = localIsoDate(today);
  const sevenDaysOut = addDays(today, 7);

  let critical = 0;
  let high = 0;
  let urgent = 0;
  let overdue = 0;
  let dueSoon = 0;
  let courtThisWeek = 0;

  for (const t of tasks) {
    if (t.priority === "critical") critical++;
    if (t.priority === "high") high++;
    const isOverdue = Boolean(t.dueDate && t.dueDate < todayIso);
    if (t.priority === "critical" || isOverdue) urgent++;
    if (t.dueDate) {
      if (isOverdue) overdue++;
      if (t.dueDate >= todayIso && t.dueDate <= sevenDaysOut) dueSoon++;
    }
    if (t.category === "court" && t.dueDate && t.dueDate >= todayIso && t.dueDate <= sevenDaysOut)
      courtThisWeek++;
  }

  return {
    total: tasks.length,
    critical,
    high,
    urgent,
    overdue,
    dueSoon,
    courtThisWeek,
    topTask: tasks[0] ?? null,
  };
}
