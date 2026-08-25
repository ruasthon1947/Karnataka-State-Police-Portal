import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import {
  CaseRecord,
  FirRecord,
  caseRoute,
  countWhere,
  csvEscape,
  findCase,
  optionList,
  pullCasesFromMaster,
  searchText,
  splitNames,
  toFirRecord,
  useCases,
  useFirRecords,
} from "../lib/cases";
import CasePassQR from "../components/CasePassQR";

type FIR = {
  id: string;
  fir: string;
  category: string;
  station: string;
  io: string;
  status: string;
  gravity: string;
  date: string;
  complainant: string;
  accused: string;
  phone: string;
  vehicle: string;
  section: string;
};

export const FIR_RECORDS: FIR[] = [
  {
    id: "CR-041/2026",
    fir: "104430041202600041",
    category: "Cyber Crime",
    station: "Whitefield PS",
    io: "S. Parvathi",
    status: "Under Investigation",
    gravity: "Heinous",
    date: "2026-07-08",
    complainant: "Ananya Rao",
    accused: "Unknown",
    phone: "9876543210",
    vehicle: "-",
    section: "BNS 318(4)",
  },
  {
    id: "CR-038/2026",
    fir: "104430006202600038",
    category: "Theft",
    station: "Indiranagar PS",
    io: "R. Krishnamurthy",
    status: "Charge-Sheeted",
    gravity: "Non-Heinous",
    date: "2026-07-07",
    complainant: "Ravi Kumar",
    accused: "Manoj K",
    phone: "9845011223",
    vehicle: "KA-03-MN-4421",
    section: "BNS 303",
  },
  {
    id: "CR-032/2026",
    fir: "104430041202600032",
    category: "Offences Against Body",
    station: "MG Road PS",
    io: "K. Srinivas",
    status: "Under Investigation",
    gravity: "Heinous",
    date: "2026-07-05",
    complainant: "Nisha S",
    accused: "Arun P",
    phone: "9900123456",
    vehicle: "-",
    section: "BNS 109",
  },
  {
    id: "CR-027/2026",
    fir: "104430011202600027",
    category: "Motor Vehicle Accident",
    station: "Yelahanka PS",
    io: "Rekha M",
    status: "Registered",
    gravity: "Non-Heinous",
    date: "2026-07-03",
    complainant: "Deepak H",
    accused: "Driver unknown",
    phone: "9988776655",
    vehicle: "KA-50-AB-9090",
    section: "BNS 281",
  },
  {
    id: "CR-019/2026",
    fir: "104430020202600019",
    category: "Narcotics",
    station: "Cubbon Park PS",
    io: "Anand Rao",
    status: "Undetected",
    gravity: "Heinous",
    date: "2026-06-29",
    complainant: "State",
    accused: "Unknown",
    phone: "-",
    vehicle: "-",
    section: "NDPS 20(b)",
  },
  {
    id: "CR-014/2026",
    fir: "104430006202600014",
    category: "Theft",
    station: "Indiranagar PS",
    io: "S. Parvathi",
    status: "Closed",
    gravity: "Non-Heinous",
    date: "2026-06-25",
    complainant: "Meera N",
    accused: "Vijay R",
    phone: "9880010101",
    vehicle: "KA-01-HH-1222",
    section: "BNS 303",
  },
];

const useT = () => useLanguage().tr;

const Card: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = "" }) => (
  <div
    className={`bg-shell border border-line rounded-xl ${className}`}
  >
    {children}
  </div>
);

const textValue = (value: unknown) => String(value || "").trim();

const uniqueText = (values: string[], fallback = "-") => {
  const unique = Array.from(new Set(values.map(textValue).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
  return unique.length ? unique.join(", ") : fallback;
};

const uniqueTextValues = (values: string[]) =>
  Array.from(new Set(values.map(textValue).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );

const countByValue = (
  records: FirRecord[],
  field: keyof CaseRecord,
  split = false
) => {
  const counts = new Map<string, number>();
  records.forEach((record) => {
    const values = split ? splitNames(record.raw[field]) : [textValue(record.raw[field])];
    values.filter(Boolean).forEach((value) => {
      counts.set(value, (counts.get(value) || 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};

const groupByKey = (
  records: FirRecord[],
  keyFn: (record: FirRecord) => string
) => {
  const groups = new Map<string, FirRecord[]>();
  records.forEach((record) => {
    const key = textValue(keyFn(record));
    if (!key) return;
    groups.set(key, [...(groups.get(key) || []), record]);
  });
  return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
};

const ReferenceHeader: React.FC<{
  title: string;
  description: string;
  loading: boolean;
  error: string;
  count: number;
}> = ({ title, description, loading, error, count }) => {
  const { tr } = useLanguage();
  return (
    <div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted mt-1">{description}</p>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-line bg-shell px-3 py-1 text-muted">
          {tr("Source: Google Sheets API", "ಮೂಲ: Google Sheets API")}
        </span>
        <span className="rounded-full border border-line bg-shell px-3 py-1 text-muted">
          {loading
            ? tr("Loading...", "ಲೋಡ್ ಆಗುತ್ತಿದೆ...")
            : tr(
              `${count.toLocaleString("en-IN")} records loaded`,
              `${count.toLocaleString("kn-IN")} ದಾಖಲೆಗಳು ಲೋಡ್ ಆಗಿವೆ`,
            )}
        </span>
        {error && (
          <span className="rounded-full border border-rose/30 bg-rose/10 px-3 py-1 text-rose">
            {error}
          </span>
        )}
      </div>
    </div>
  );
};

const ReferenceStat: React.FC<{
  label: string;
  value: number | string;
  helper?: string;
}> = ({ label, value, helper }) => (
  <Card className="p-4">
    <div className="text-xs text-muted">{label}</div>
    <div className="mt-2 text-2xl font-semibold">{value}</div>
    {helper && <div className="text-[11px] text-muted mt-1">{helper}</div>}
  </Card>
);

const ReferenceTable: React.FC<{
  columns: string[];
  rows: Array<Array<React.ReactNode>>;
  emptyText?: string;
}> = ({ columns, rows, emptyText = "No reference data found." }) => (
  <Card className="overflow-hidden">
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[10px] uppercase text-muted">
            {columns.map((column) => (
              <th key={column} className="px-4 py-3 font-semibold">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-line last:border-0">
              {row.map((cell, cellIndex) => (
                <td key={`${rowIndex}-${cellIndex}`} className="px-4 py-3 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-muted">
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  </Card>
);

const ReferenceListCard: React.FC<{
  title: string;
  values: Array<{ name: string; count: number }>;
}> = ({ title, values }) => (
  <Card className="p-4">
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-muted">{values.length} values</div>
    </div>
    <div className="mt-4 max-h-72 overflow-auto space-y-2 pr-1">
      {values.map((item) => (
        <div
          key={item.name}
          className="flex items-start justify-between gap-4 rounded-lg border border-line bg-panel/40 px-3 py-2"
        >
          <span className="text-sm">{item.name}</span>
          <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
            {item.count}
          </span>
        </div>
      ))}
      {values.length === 0 && <div className="text-sm text-muted">No values found.</div>}
    </div>
  </Card>
);

/* =========================================================
   CHART TOOLTIP
   Works in light and dark mode
========================================================= */

const ChartTooltip = ({
  active,
  payload,
  label,
}: any) => {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  return (
    <div className="bg-shell border border-line rounded-xl px-4 py-3 shadow-xl text-white">
      {label !== undefined && label !== null && (
        <div className="text-sm font-semibold text-white mb-2">
          {label}
        </div>
      )}

      <div className="space-y-1.5">
        {payload.map((item: any, index: number) => (
          <div
            key={`${item.dataKey || item.name}-${index}`}
            className="flex items-center justify-between gap-6 text-sm"
          >
            <span className="text-muted capitalize">
              {item.name || item.dataKey}
            </span>

            <span className="font-semibold text-white num">
              {item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* =========================================================
   DASHBOARD
========================================================= */

export const Dashboard: React.FC = () => {
  const t = useT();
  const nav = useNavigate();
  const { user } = useAuth();
  const { records, loading, error } = useFirRecords();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      const caseDate = r.date || r.raw.CrimeRegisteredDate;
      if (fromDate && caseDate < fromDate) return false;
      if (toDate && caseDate > toDate) return false;
      return true;
    });
  }, [records, fromDate, toDate]);

  const totalCases = filteredRecords.length;
  const underInvestigation = countWhere(filteredRecords, (r) => r.status === "Under Investigation");
  const chargeSheetsDue = countWhere(
    filteredRecords,
    (r) => (r.raw.ChargesheetStatus || "Pending") !== "Filed" && r.status !== "Disposed by Court",
  );
  const highGravity = countWhere(filteredRecords, (r) => r.gravity === "Heinous");
  const closedStatuses = ["Charge Sheeted", "Disposed by Court", "Closed - False Case"];
  const employeeTail = user?.employeeId?.split("-").pop() || "";
  const assignedRecords = filteredRecords.filter(
    (r) =>
      (employeeTail && r.raw.EmployeeID === employeeTail) ||
      (user?.name && r.io === user.name),
  );
  const myActiveCases = assignedRecords.filter((r) => r.status === "Under Investigation").length;
  const disposedCases = countWhere(filteredRecords, (r) => closedStatuses.includes(r.status));
  const disposalRate = totalCases ? Math.round((disposedCases / totalCases) * 1000) / 10 : 0;
  const avgInvestigationDays = (() => {
    const durations = filteredRecords
      .map((record) => {
        const start = new Date(record.date);
        const end = new Date(record.raw.LatestChargesheetDate || new Date().toISOString().slice(0, 10));
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
        return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
      })
      .filter((value): value is number => value !== null);
    if (!durations.length) return 0;
    return Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * 10) / 10;
  })();

  const metrics = [
    [
      t("Total FIRs", "ಒಟ್ಟು ಎಫ್‌ಐಆರ್‌ಗಳು"),
      loading ? "..." : totalCases.toLocaleString("en-IN"),
      String(totalCases),
      t("vs yesterday", "ನಿನ್ನೆಗಿಂತ"),
      "",
    ],
    [
      t("Under Investigation", "ತನಿಖೆಯಲ್ಲಿರುವ ಪ್ರಕರಣಗಳು"),
      loading ? "..." : underInvestigation.toLocaleString("en-IN"),
      String(underInvestigation),
      t("updated today", "ಇಂದು ನವೀಕರಿಸಲಾಗಿದೆ"),
      "status=Under Investigation",
    ],
    [
      t("Charge sheets due", "ಚಾರ್ಜ್‌ಶೀಟ್ ಬಾಕಿ"),
      loading ? "..." : chargeSheetsDue.toLocaleString("en-IN"),
      String(chargeSheetsDue),
      t("days ahead", "ಮುಂದಿನ ದಿನಗಳು"),
      "",
    ],
    [
      t("High gravity", "ಗಂಭೀರ ಪ್ರಕರಣಗಳು"),
      loading ? "..." : highGravity.toLocaleString("en-IN"),
      String(highGravity),
      t("new this week", "ಈ ವಾರ ಹೊಸದು"),
      "gravity=Heinous",
    ],
  ];

  const activity = useMemo(() => {
    let start = new Date();
    start.setDate(start.getDate() - 6);
    let end = new Date();

    if (fromDate) start = new Date(fromDate);
    if (toDate) end = new Date(toDate);

    const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    const groupByMonth = diffDays > 60;

    if (groupByMonth) {
      const buckets = new Map<string, { day: string; fir: number; solved: number }>();
      let d = new Date(start);
      d.setDate(1);
      while (d <= end) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const label = d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
        buckets.set(key, { day: label, fir: 0, solved: 0 });
        d.setMonth(d.getMonth() + 1);
      }
      for (const record of filteredRecords) {
        const date = new Date(record.date);
        if (!Number.isFinite(date.getTime())) continue;
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        if (buckets.has(key)) {
          const b = buckets.get(key)!;
          b.fir++;
          if (closedStatuses.includes(record.status)) b.solved++;
        }
      }
      return Array.from(buckets.values());
    } else {
      const days = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const iso = d.toISOString().slice(0, 10);
        const dayRecords = filteredRecords.filter((record) => record.date === iso);
        days.push({
          day: d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
          fir: dayRecords.length,
          solved: dayRecords.filter((record) => closedStatuses.includes(record.status)).length,
        });
      }
      return days;
    }
  }, [filteredRecords, fromDate, toDate]);

  const attention = [
    [
      "CR-041/2026",
      t(
        "Investigation update overdue",
        "ತನಿಖಾ ನವೀಕರಣ ಬಾಕಿ"
      ),
      t("3 days overdue", "3 ದಿನ ಬಾಕಿ"),
    ],
    [
      "CR-032/2026",
      t(
        "Supervisor review requested",
        "ಮೇಲ್ವಿಚಾರಕರ ಪರಿಶೀಲನೆ ಅಗತ್ಯ"
      ),
      t("Priority", "ಆದ್ಯತೆ"),
    ],
    [
      "CR-027/2026",
      t(
        "Charge sheet deadline",
        "ಚಾರ್ಜ್‌ಶೀಟ್ ಗಡುವು"
      ),
      t("Due in 2 days", "2 ದಿನಗಳಲ್ಲಿ ಗಡುವು"),
    ],
  ];
  const liveAttention = filteredRecords
    .filter((record) => record.status === "Under Investigation" || record.gravity === "Heinous")
    .slice(0, 3)
    .map((record) => [
      caseRoute(record.raw),
      record.label,
      record.status || record.gravity || record.category,
    ]);
  const attentionRows = liveAttention;
  const metricFooters = [
    "loaded from Consolidated_Cases",
    "currently under investigation",
    "without filed chargesheet",
    "marked heinous",
  ];
  const dashboardSubtitles = [
    `${assignedRecords.length} assigned to current login`,
    `${disposedCases} disposed / charge-sheeted`,
    "days from registration to latest case state",
  ];

  return (
    <div className="p-5 md:p-6 space-y-5 max-w-[1500px] mx-auto w-full">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-2">
        <div>
          <h1 className="text-xl font-semibold">{t("Dashboard", "ಡ್ಯಾಶ್‌ಬೋರ್ಡ್")}</h1>
          <p className="text-sm text-muted mt-1">{t("Overview of FIRs and activity.", "ಎಫ್‌ಐಆರ್‌ಗಳ ಅವಲೋಕನ ಮತ್ತು ಚಟುವಟಿಕೆ.")}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {metrics.map((m, i) => (
          <button
            key={String(m[0])}
            onClick={() =>
              nav(`/fir${m[4] ? `?${m[4]}` : ""}`)
            }
            className="group text-left bg-shell border border-line rounded-xl p-4 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-soft transition"
          >
            <div className="flex justify-between items-start">
              <div className="text-[11px] text-muted uppercase tracking-wide">
                {m[0]}
              </div>

              <div className="h-8 w-8 rounded-lg bg-brand/10 text-brand grid place-items-center text-xs font-bold">
                {i + 1}
              </div>
            </div>

            <div className="text-3xl font-semibold mt-3 num">
              {m[1]}
            </div>

            <div className="text-[11px] text-muted mt-1">
              {metricFooters[i]}
            </div>
          </button>
        ))}
      </div>

      <div className="grid xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,.75fr)] gap-4">
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="font-semibold">
                {t(
                  "FIR activity",
                  "ಎಫ್‌ಐಆರ್ ಚಟುವಟಿಕೆ"
                )}
              </div>

              <div className="text-xs text-muted mt-1">
                {t(
                  "Registered vs solved",
                  "ನೋಂದಾಯಿತ ಮತ್ತು ಪರಿಹರಿಸಿದ"
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-4 items-center">
              <div className="flex gap-3">
                <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-8 px-2 bg-panel border border-line rounded text-xs outline-none focus:border-brand" />
                <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-8 px-2 bg-panel border border-line rounded text-xs outline-none focus:border-brand" />
              </div>
              <div className="flex gap-4 text-[11px] text-muted">
                <span>
                  ● {t("Registered", "ನೋಂದಾಯಿತ")}
                </span>

                <span>
                  ◌ {t("Solved", "ಪರಿಹರಿಸಲಾಗಿದೆ")}
                </span>
              </div>
            </div>
          </div>

          <div className="h-[310px] mt-5">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={activity}>
                <CartesianGrid strokeDasharray="3 3" />

                <XAxis
                  dataKey="day"
                  fontSize={11}
                  label={{ value: "Date", position: "insideBottomRight", offset: -5, fontSize: 10, fill: "var(--muted)" }}
                />

                <YAxis fontSize={11} label={{ value: "Number of FIRs", angle: -90, position: "insideLeft", fontSize: 10, fill: "var(--muted)" }} />

                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--shell)",
                    border: "1px solid var(--line)",
                    borderRadius: "10px",
                    color: "var(--text)",
                  }}
                  labelStyle={{
                    color: "var(--text)",
                  }}
                  itemStyle={{
                    color: "var(--text)",
                  }}
                />

                <Line
                  type="monotone"
                  dataKey="fir"
                  stroke="currentColor"
                  strokeWidth={3}
                  dot={{
                    r: 4,
                    fill: "currentColor",
                  }}
                />

                <Line
                  type="monotone"
                  dataKey="solved"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeDasharray="6 5"
                  dot={{
                    r: 3,
                    fill: "currentColor",
                  }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <div>
            <div className="font-semibold">
              {t(
                "Needs attention",
                "ಗಮನ ಅಗತ್ಯ"
              )}
            </div>

            <div className="text-xs text-muted mt-1">
              {t(
                "Cases requiring officer action",
                "ಅಧಿಕಾರಿಯ ಕ್ರಮ ಅಗತ್ಯವಿರುವ ಪ್ರಕರಣಗಳು"
              )}
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {!loading && attentionRows.length === 0 && (
              <p className="rounded-lg border border-line p-3 text-sm text-muted">
                No cases currently require attention.
              </p>
            )}
            {attentionRows.map((x) => (
              <button
                key={x[0]}
                onClick={() => nav(`/fir/${x[0]}`)}
                className="w-full text-left border border-line rounded-lg p-3 hover:border-brand/40 hover:bg-panel transition"
              >
                <div className="flex justify-between gap-3">
                  <div>
                    <div className="text-xs text-brand font-semibold">
                      {x[0]}
                    </div>

                    <div className="text-sm font-medium mt-1">
                      {x[1]}
                    </div>
                  </div>

                  <span className="text-[10px] text-brand">
                    {x[2]}
                  </span>
                </div>
              </button>
            ))}
          </div>

          <button
            onClick={() => nav("/fir")}
            className="w-full mt-3 h-9 rounded-lg border border-line text-xs font-semibold hover:border-brand/40 transition"
          >
            {t(
              "View all cases",
              "ಎಲ್ಲ ಪ್ರಕರಣಗಳನ್ನು ನೋಡಿ"
            )}{" "}
            →
          </button>
        </Card>
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        {[
          [
            t(
              "My active cases",
              "ನನ್ನ ಸಕ್ರಿಯ ಪ್ರಕರಣಗಳು"
            ),
            loading ? "..." : String(myActiveCases),
            t(
              "4 need an update today",
              "4 ಪ್ರಕರಣಗಳಿಗೆ ಇಂದು ನವೀಕರಣ ಅಗತ್ಯ"
            ),
          ],
          [
            t(
              "City disposal rate",
              "ನಗರ ವಿಲೇವಾರಿ ದರ"
            ),
            loading ? "..." : `${disposalRate}%`,
            t(
              "Up 3.1% this month",
              "ಈ ತಿಂಗಳು 3.1% ಹೆಚ್ಚಳ"
            ),
          ],
          [
            t(
              "Average investigation",
              "ಸರಾಸರಿ ತನಿಖೆ"
            ),
            loading ? "..." : String(avgInvestigationDays),
            t(
              "days · target below 21",
              "ದಿನಗಳು · ಗುರಿ 21 ಕ್ಕಿಂತ ಕಡಿಮೆ"
            ),
          ],
        ].map((x, index) => (
          <Card
            key={String(x[0])}
            className="p-4"
          >
            <div className="text-xs text-muted">
              {x[0]}
            </div>

            <div className="text-2xl font-semibold mt-2">
              {x[1]}
            </div>

            <div className="text-[11px] text-muted mt-1">
              {dashboardSubtitles[index] ?? x[2]}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};

/* =========================================================
   FIR LIST
========================================================= */

export const FIRList: React.FC = () => {
  const t = useT();
  const nav = useNavigate();
  const { records, loading, error } = useFirRecords();
  const [searchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const statusFilter = searchParams.get("status") || "";
  const gravityFilter = searchParams.get("gravity") || "";
  const visibleRecords = useMemo(
    () =>
      records.filter(
        (record) =>
          (!statusFilter || record.status === statusFilter) &&
          (!gravityFilter || record.gravity === gravityFilter),
      ),
    [records, statusFilter, gravityFilter],
  );
  const pageCount = Math.max(1, Math.ceil(visibleRecords.length / pageSize));
  const pageRecords = visibleRecords.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => setPage(1), [statusFilter, gravityFilter]);

  return (
    <div className="p-5">
      <Card className="p-5">
        <div className="flex justify-between">
          <div>
            <h1 className="text-lg font-semibold">
              {t(
                "FIR Records",
                "ಎಫ್‌ಐಆರ್ ದಾಖಲೆಗಳು"
              )}
            </h1>

            <p className="text-sm text-muted mt-1">
              {t(
                "Open a case to view the complete file and timeline.",
                "ಸಂಪೂರ್ಣ ಪ್ರಕರಣ ಮತ್ತು ಕಾಲರೇಖೆ ನೋಡಲು ಪ್ರಕರಣ ತೆರೆಯಿರಿ."
              )}
            </p>
          </div>

          <button
            onClick={() => nav("/fir/new")}
            className="bg-brand rounded-lg px-4 h-9 text-sm"
          >
            +{" "}
            {t(
              "Register FIR",
              "ಎಫ್‌ಐಆರ್ ನೋಂದಣಿ"
            )}
          </button>
        </div>

        {loading && (
          <div className="mt-5 rounded-lg border border-line p-4 text-sm text-muted" role="status">
            Loading FIR records…
          </div>
        )}
        {error && (
          <div className="mt-5 rounded-lg border border-rose/30 bg-rose/10 p-4 text-sm text-rose" role="alert">
            {error}
          </div>
        )}
        {!loading && !error && visibleRecords.length === 0 && (
          <div className="mt-5 rounded-lg border border-line p-4 text-sm text-muted">
            No FIR records match the selected filters.
          </div>
        )}

        <div className="overflow-x-auto mt-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[10px] uppercase text-muted">
                <th className="py-3">
                  {t("Case", "ಪ್ರಕರಣ")}
                </th>

                <th>
                  {t("Category", "ವರ್ಗ")}
                </th>

                <th>
                  {t("Station", "ಠಾಣೆ")}
                </th>

                <th>IO</th>

                <th>
                  {t("Registered", "ನೋಂದಣಿ")}
                </th>

                <th>
                  {t("Status", "ಸ್ಥಿತಿ")}
                </th>

                <th />
              </tr>
            </thead>

            <tbody>
              {pageRecords.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => nav(`/fir/${caseRoute(r.raw)}`)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      nav(`/fir/${caseRoute(r.raw)}`);
                    }
                  }}
                  role="link"
                  tabIndex={0}
                  className="border-b border-line hover:bg-panel cursor-pointer"
                >
                  <td className="py-3">
                    <div className="font-semibold text-brand">
                      {r.label}
                    </div>

                    <div className="text-[10px] text-muted num">
                      {r.fir}
                    </div>
                  </td>

                  <td>{r.category}</td>
                  <td>{r.station}</td>
                  <td>{r.io}</td>
                  <td>{r.date}</td>

                  <td>
                    <span className="text-xs border border-line rounded-full px-2 py-1">
                      {r.status}
                    </span>
                  </td>

                  <td className="text-brand">
                    {t("Open", "ತೆರೆಯಿರಿ")} ›
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && !error && visibleRecords.length > pageSize && (
          <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted">
            <span>
              Showing {(page - 1) * pageSize + 1}–
              {Math.min(page * pageSize, visibleRecords.length)} of {visibleRecords.length}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page === 1}
                className="rounded-lg border border-line px-3 py-2 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                disabled={page === pageCount}
                className="rounded-lg border border-line px-3 py-2 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

/* =========================================================
   FIR DETAIL
========================================================= */

export const FIRDetail: React.FC = () => {
  const t = useT();
  const { id } = useParams();
  const nav = useNavigate();
  const { cases, loading, error } = useFirRecords();
  const [showQR, setShowQR] = useState(false);

  const matchedCase = findCase(cases, id);
  const r = matchedCase ? toFirRecord(matchedCase) : undefined;

  if (loading) {
    return <div className="p-5 text-sm text-muted">Loading case from Google Sheets...</div>;
  }

  if (error) {
    return <div className="p-5 text-sm text-rose">{error}</div>;
  }

  if (!r) {
    return <div className="p-5 text-sm text-muted">Case not found in Google Sheets.</div>;
  }

  const timeline = [
    [
      t(
        "FIR Registered",
        "ಎಫ್‌ಐಆರ್ ನೋಂದಾಯಿಸಲಾಗಿದೆ"
      ),
      "08 Jul 2026 · 09:12",
      t(
        "Registered by Officer 10427",
        "ಅಧಿಕಾರಿ 10427ರಿಂದ ನೋಂದಣಿ"
      ),
    ],
    [
      t(
        "IO Assigned",
        "ತನಿಖಾಧಿಕಾರಿ ನಿಯೋಜನೆ"
      ),
      "08 Jul 2026 · 09:30",
      r.io,
    ],
    [
      t(
        "Statement Added",
        "ಹೇಳಿಕೆ ಸೇರಿಸಲಾಗಿದೆ"
      ),
      "08 Jul 2026 · 11:45",
      t(
        "Complainant statement recorded",
        "ದೂರುದಾರರ ಹೇಳಿಕೆ ದಾಖಲಿಸಲಾಗಿದೆ"
      ),
    ],
    [
      t(
        "Evidence Uploaded",
        "ಸಾಕ್ಷ್ಯ ಅಪ್‌ಲೋಡ್"
      ),
      "08 Jul 2026 · 14:20",
      t(
        "2 digital evidence files",
        "2 ಡಿಜಿಟಲ್ ಸಾಕ್ಷ್ಯ ಕಡತಗಳು"
      ),
    ],
    [
      t(
        "Investigation Note",
        "ತನಿಖಾ ಟಿಪ್ಪಣಿ"
      ),
      "09 Jul 2026 · 10:05",
      t(
        "Preliminary review completed",
        "ಪ್ರಾಥಮಿಕ ಪರಿಶೀಲನೆ ಪೂರ್ಣ"
      ),
    ],
  ];
  const liveTimeline = [
    r.raw.CrimeRegisteredDate
      ? [
        t("FIR Registered", "FIR Registered"),
        r.raw.CrimeRegisteredDate,
        r.raw.FiledBy ? `Filed by ${r.raw.FiledBy}` : "Registration recorded",
      ]
      : null,
    r.raw.InfoReceivedPSDate
      ? [
        t("Information received", "Information received"),
        r.raw.InfoReceivedPSDate,
        r.station || "Police station",
      ]
      : null,
    r.raw.IncidentFromDate
      ? [
        t("Incident period", "Incident period"),
        [r.raw.IncidentFromDate, r.raw.IncidentToDate].filter(Boolean).join(" – "),
        r.raw.BriefFacts || "Incident details recorded",
      ]
      : null,
    r.io
      ? [
        t("Investigating officer assigned", "Investigating officer assigned"),
        r.raw.CrimeRegisteredDate || "Date not recorded",
        r.io,
      ]
      : null,
    r.raw.LatestChargesheetDate || r.raw.ChargesheetStatus
      ? [
        t("Chargesheet status", "Chargesheet status"),
        r.raw.LatestChargesheetDate || "Date not recorded",
        r.raw.ChargesheetStatus || "Status not recorded",
      ]
      : null,
  ].filter((item): item is string[] => Boolean(item));

  return (
    <div className="p-5 space-y-4">
      <div>
        <div className="text-xs text-brand">
          {r.label}
        </div>

        <h1 className="text-xl font-semibold mt-1">
          {r.category}
        </h1>

        <p className="text-sm text-muted">
          {r.station} · {r.status}
        </p>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => nav(`/fir/${caseRoute(r.raw)}/edit`)}
          className="h-9 px-3 rounded-lg bg-brand text-white text-xs font-semibold"
        >
          Edit
        </button>
        <button
          onClick={() => setShowQR(true)}
          className="h-9 px-3 rounded-lg border border-line hover:bg-panel text-xs font-semibold flex items-center gap-2"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
            <path d="M7 7h.01"></path>
            <path d="M18 7h.01"></path>
            <path d="M18 18h.01"></path>
            <path d="M7 18h.01"></path>
          </svg>
          Case Pass QR
        </button>
      </div>

      {showQR && <CasePassQR record={r.raw} onClose={() => setShowQR(false)} />}

      <div className="grid xl:grid-cols-[1fr_420px] gap-4">
        <Card className="p-5">
          <div className="font-semibold">
            {t(
              "Case summary",
              "ಪ್ರಕರಣ ಸಾರಾಂಶ"
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
            {[
              [
                t(
                  "FIR number",
                  "ಎಫ್‌ಐಆರ್ ಸಂಖ್ಯೆ"
                ),
                r.fir,
              ],
              [
                t(
                  "Investigating officer",
                  "ತನಿಖಾಧಿಕಾರಿ"
                ),
                r.io,
              ],
              [
                t(
                  "Complainant",
                  "ದೂರುದಾರ"
                ),
                r.complainant,
              ],
              [
                t("Accused", "ಆರೋಪಿ"),
                r.accused,
              ],
              [
                t("Section", "ಸೆಕ್ಷನ್"),
                r.section,
              ],
              [
                t("Gravity", "ಗಂಭೀರತೆ"),
                r.gravity,
              ],
            ].map((x) => (
              <div key={x[0]}>
                <div className="text-[11px] text-muted uppercase">
                  {x[0]}
                </div>

                <div className="mt-1">
                  {x[1]}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="font-semibold">
            {t(
              "Case timeline",
              "ಪ್ರಕರಣ ಕಾಲರೇಖೆ"
            )}
          </div>

          <div className="mt-5">
            {liveTimeline.length === 0 && (
              <p className="text-sm text-muted">No dated case events are recorded.</p>
            )}
            {liveTimeline.map((x, i) => (
              <div
                className="relative pl-7 pb-5"
                key={x[0]}
              >
                <span className="absolute left-0 top-1 h-3 w-3 rounded-full bg-brand border-2 border-shell" />

                {i < liveTimeline.length - 1 && (
                  <span className="absolute left-[5px] top-4 bottom-0 w-px bg-line" />
                )}

                <div className="text-sm font-medium">
                  {x[0]}
                </div>

                <div className="text-[11px] text-muted mt-1">
                  {x[1]}
                </div>

                <div className="text-xs text-muted mt-1">
                  {x[2]}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

    </div>
  );
};

/* =========================================================
   ADVANCED SEARCH
========================================================= */

export const AdvancedSearch: React.FC = () => {
  const t = useT();
  const [searchParams] = useSearchParams();

  const [q, setQ] = useState(() => searchParams.get("q") || "");
  const [station, setStation] = useState(() => searchParams.get("station") || "");
  const [status, setStatus] = useState(() => searchParams.get("status") || "");

  const [saved, setSaved] = useState<string[]>(() =>
    JSON.parse(
      localStorage.getItem("kpfir.savedSearches") ||
      "[]"
    )
  );

  const [recent, setRecent] = useState<string[]>(() =>
    JSON.parse(
      localStorage.getItem("kpfir.recentSearches") ||
      "[]"
    )
  );

  const nav = useNavigate();
  const { records, options, loading, error } = useFirRecords();

  const results = useMemo(
    () =>
      records.filter((r) => {
        const hay = searchText(r);

        return (
          (!q ||
            hay.includes(q.toLowerCase())) &&
          (!station || r.station === station) &&
          (!status || r.status === status)
        );
      }),
    [q, records, station, status]
  );

  const run = () => {
    if (!q) return;

    const n = [
      q,
      ...recent.filter((x) => x !== q),
    ].slice(0, 5);

    setRecent(n);

    localStorage.setItem(
      "kpfir.recentSearches",
      JSON.stringify(n)
    );
  };

  const save = () => {
    const name =
      q || `${station} ${status}`.trim();

    if (!name) return;

    const n = [
      name,
      ...saved.filter((x) => x !== name),
    ].slice(0, 6);

    setSaved(n);

    localStorage.setItem(
      "kpfir.savedSearches",
      JSON.stringify(n)
    );
  };

  return (
    <div className="p-5 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">
          {t(
            "Advanced Search",
            "ಸುಧಾರಿತ ಹುಡುಕಾಟ"
          )}
        </h1>

        <p className="text-sm text-muted mt-1">
          {t(
            "Search across FIR number, names, phone, vehicle, section, station and IO.",
            "ಎಫ್‌ಐಆರ್ ಸಂಖ್ಯೆ, ಹೆಸರು, ಫೋನ್, ವಾಹನ, ಸೆಕ್ಷನ್, ಠಾಣೆ ಮತ್ತು ತನಿಖಾಧಿಕಾರಿ ಮೂಲಕ ಹುಡುಕಿ."
          )}
        </p>
      </div>

      <Card className="p-4">
        <div className="grid lg:grid-cols-[1fr_220px_220px_auto] gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && run()
            }
            placeholder={t(
              "Crime no, name, phone, vehicle, section...",
              "ಪ್ರಕರಣ ಸಂಖ್ಯೆ, ಹೆಸರು, ಫೋನ್, ವಾಹನ, ಸೆಕ್ಷನ್..."
            )}
            className="h-10 bg-panel border border-line rounded-lg px-3 text-sm outline-none focus:border-brand"
          />

          <select
            value={station}
            onChange={(e) =>
              setStation(e.target.value)
            }
            className="h-10 bg-panel border border-line rounded-lg px-3 text-sm"
          >
            <option value="">
              {t("All stations", "ಎಲ್ಲ ಠಾಣೆಗಳು")}
            </option>

            {optionList(options, "PoliceStation").map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>

          <select
            value={status}
            onChange={(e) =>
              setStatus(e.target.value)
            }
            className="h-10 bg-panel border border-line rounded-lg px-3 text-sm"
          >
            <option value="">
              {t("All statuses", "ಎಲ್ಲ ಸ್ಥಿತಿಗಳು")}
            </option>

            {optionList(options, "Status").map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>

          <button
            onClick={run}
            className="h-10 px-4 bg-brand rounded-lg text-sm font-semibold"
          >
            {t("Search", "ಹುಡುಕಿ")}
          </button>
        </div>

        <div className="flex gap-3 mt-3">
          <button
            onClick={save}
            className="h-9 px-3 border border-line rounded-lg text-xs"
          >
            ☆{" "}
            {t(
              "Save search",
              "ಹುಡುಕಾಟ ಉಳಿಸಿ"
            )}
          </button>

          <span className="text-xs text-muted self-center">
            {results.length}{" "}
            {t(
              "matching cases",
              "ಹೊಂದುವ ಪ್ರಕರಣಗಳು"
            )}
          </span>
        </div>
      </Card>

      <div className="grid xl:grid-cols-[240px_1fr] gap-4">
        <div className="space-y-4">
          <Card className="p-4">
            <div className="text-sm font-semibold">
              {t(
                "Recent searches",
                "ಇತ್ತೀಚಿನ ಹುಡುಕಾಟಗಳು"
              )}
            </div>

            {recent.map((x) => (
              <button
                key={x}
                onClick={() => setQ(x)}
                className="block text-left text-xs text-muted hover:text-brand mt-3"
              >
                ↻ {x}
              </button>
            ))}
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">
              {t(
                "Saved searches",
                "ಉಳಿಸಿದ ಹುಡುಕಾಟಗಳು"
              )}
            </div>

            {saved.map((x) => (
              <button
                key={x}
                onClick={() => setQ(x)}
                className="block text-left text-xs text-muted hover:text-brand mt-3"
              >
                ☆ {x}
              </button>
            ))}
          </Card>
        </div>

        <Card className="p-4">
          <div className="space-y-2">
            {results.map((r) => (
              <button
                onClick={() =>
                  nav(`/fir/${caseRoute(r.raw)}`)
                }
                key={r.id}
                className="w-full p-3 rounded-lg border border-line hover:border-brand/40 text-left flex justify-between"
              >
                <div>
                  <div className="text-sm font-semibold text-brand">
                    {r.label}
                  </div>

                  <div className="text-xs text-muted mt-1">
                    {r.category} · {r.complainant} ·{" "}
                    {r.station}
                  </div>
                </div>

                <div className="text-xs text-muted">
                  {r.status}
                </div>
              </button>
            ))}

            {results.length === 0 && (
              <div className="py-12 text-center text-sm text-muted">
                {t(
                  "No FIR records match the selected filters.",
                  "ಆಯ್ಕೆ ಮಾಡಿದ ಫಿಲ್ಟರ್‌ಗಳಿಗೆ ಹೊಂದುವ ಎಫ್‌ಐಆರ್ ದಾಖಲೆಗಳಿಲ್ಲ."
                )}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};

/* =========================================================
   REPORTS
========================================================= */

export const Reports: React.FC = () => {
  const t = useT();
  const { records, loading, error } = useFirRecords();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const closedStatuses = ["Charge Sheeted", "Disposed by Court", "Closed - False Case"];
  const today = new Date();

  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      const caseDate = r.date || r.raw.CrimeRegisteredDate;
      if (fromDate && caseDate < fromDate) return false;
      if (toDate && caseDate > toDate) return false;
      return true;
    });
  }, [records, fromDate, toDate]);

  const daysBetween = (from: string, to?: string) => {
    const start = new Date(from);
    const end = to ? new Date(to) : today;
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
    return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
  };

  const monthly = useMemo(() => {
    let start = new Date();
    start.setDate(start.getDate() - 180); // Default 6 months
    let end = new Date();

    if (fromDate) start = new Date(fromDate);
    if (toDate) end = new Date(toDate);

    const buckets = new Map<string, { m: string; fir: number; closed: number }>();

    // Initialize buckets for all months in range
    let d = new Date(start);
    d.setDate(1); // Set to start of month
    while (d <= end) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
      buckets.set(key, { m: label, fir: 0, closed: 0 });
      d.setMonth(d.getMonth() + 1);
    }

    for (const record of filteredRecords) {
      const date = new Date(record.date);
      if (!Number.isFinite(date.getTime())) continue;
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      if (!buckets.has(key)) continue; // Outside filter range

      const bucket = buckets.get(key)!;
      bucket.fir += 1;
      if (closedStatuses.includes(record.status)) {
        bucket.closed += 1;
      }
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value);
  }, [filteredRecords, fromDate, toDate]);

  const station = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const record of filteredRecords) {
      const key = record.station || "Unassigned";
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    return Array.from(buckets.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, value]) => ({ n: name.replace(" Police Station", ""), v: value }));
  }, [filteredRecords]);

  const pie = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const record of filteredRecords) {
      const key = record.raw.CrimeHead || record.category || "Other";
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    return Array.from(buckets.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, value]) => ({ name, value }));
  }, [filteredRecords]);

  const totalCases = filteredRecords.length;
  const closedCases = filteredRecords.filter((record) => closedStatuses.includes(record.status));
  const disposalRate = totalCases ? Math.round((closedCases.length / totalCases) * 1000) / 10 : 0;
  const investigationDurations = filteredRecords
    .map((record) => daysBetween(record.date, record.raw.LatestChargesheetDate || undefined))
    .filter((value): value is number => value !== null);
  const avgInvestigationDays = investigationDurations.length
    ? Math.round(
      (investigationDurations.reduce((sum, value) => sum + value, 0) / investigationDurations.length) * 10
    ) / 10
    : 0;
  const casesThisMonth = filteredRecords.filter((record) => {
    const date = new Date(record.date);
    return (
      Number.isFinite(date.getTime()) &&
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth()
    );
  }).length;
  const overdueCases = filteredRecords.filter((record) => {
    const age = daysBetween(record.date);
    return age !== null && age > 30 && !closedStatuses.includes(record.status);
  }).length;
  const disposedWithin30 = closedCases.length
    ? Math.round(
      (closedCases.filter((record) => {
        const age = daysBetween(record.date, record.raw.LatestChargesheetDate || undefined);
        return age !== null && age <= 30;
      }).length /
        closedCases.length) *
      100
    )
    : 0;
  const chargeSheetsFiled = filteredRecords.filter((record) => record.raw.ChargesheetStatus === "Filed").length;
  const chargeSheetFiledRate = totalCases ? Math.round((chargeSheetsFiled / totalCases) * 100) : 0;
  const investigationCurrentRate = totalCases ? Math.round(((totalCases - overdueCases) / totalCases) * 100) : 0;
  const statusRows = countByValue(filteredRecords, "Status").map((item) => [
    item.name,
    item.count.toLocaleString("en-IN"),
    totalCases ? `${Math.round((item.count / totalCases) * 1000) / 10}%` : "0%",
  ]);
  const stationRows = station.map((item) => [
    item.n,
    item.v.toLocaleString("en-IN"),
    totalCases ? `${Math.round((item.v / totalCases) * 1000) / 10}%` : "0%",
  ]);

  const csv = () => {
    const rows = [
      "Case,FIR,Category,Station,Status,Gravity,Registered,Officer,Complainant,Accused,Sections",
      ...filteredRecords.map(
        (r) =>
          [
            r.label,
            r.fir,
            r.category,
            r.station,
            r.status,
            r.gravity,
            r.date,
            r.io,
            r.complainant,
            r.accused,
            r.section,
          ]
            .map(csvEscape)
            .join(",")
      ),
    ];

    const url = URL.createObjectURL(
      new Blob([rows.join("\n")], {
        type: "text/csv",
      })
    );

    const a = document.createElement("a");

    a.href = url;
    a.download = "fir-report.csv";
    a.click();

    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-5 space-y-4">
      <div className="flex justify-between">
        <div>
          <h1 className="text-xl font-semibold">
            {t(
              "Reports & Analytics",
              "ವರದಿಗಳು ಮತ್ತು ವಿಶ್ಲೇಷಣೆ"
            )}
          </h1>

          <p className="text-sm text-muted mt-1">
            {t(
              "Operational trends, workload and disposal performance.",
              "ಕಾರ್ಯಾಚರಣಾ ಪ್ರವೃತ್ತಿ, ಕೆಲಸದ ಹೊರೆ ಮತ್ತು ವಿಲೇವಾರಿ ಕಾರ್ಯಕ್ಷಮತೆ."
            )}
          </p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => window.print()}
            className="h-9 px-3 border border-line rounded-lg text-xs"
          >
            {t(
              "Print / Save PDF",
              "ಪಿಡಿಎಫ್ ರಚಿಸಿ"
            )}
          </button>

          <button
            onClick={csv}
            className="h-9 px-3 bg-brand rounded-lg text-xs"
          >
            {t(
              "Export CSV",
              "ಸಿಎಸ್ವಿ ರಫ್ತು"
            )}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {[
          [
            t(
              "Disposal rate",
              "ವಿಲೇವಾರಿ ದರ"
            ),
            loading ? "..." : `${disposalRate}%`,
          ],
          [
            t(
              "Avg. investigation",
              "ಸರಾಸರಿ ತನಿಖೆ"
            ),
            loading ? "..." : `${avgInvestigationDays} days`,
          ],
          [
            t(
              "Cases this month",
              "ಈ ತಿಂಗಳ ಪ್ರಕರಣಗಳು"
            ),
            loading ? "..." : casesThisMonth.toLocaleString("en-IN"),
          ],
          [
            t("Overdue", "ಬಾಕಿ"),
            loading ? "..." : overdueCases.toLocaleString("en-IN"),
          ],
        ].map((x) => (
          <Card
            className="p-4"
            key={x[0]}
          >
            <div className="text-[11px] text-muted uppercase">
              {x[0]}
            </div>

            <div className="text-2xl font-semibold mt-2">
              {x[1]}
            </div>
          </Card>
        ))}
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        <ChartCard
          title={t(
            "FIR and disposal trend",
            "ಎಫ್‌ಐಆರ್ ಮತ್ತು ವಿಲೇವಾರಿ ಪ್ರವೃತ್ತಿ"
          )}
          action={
            <div className="flex gap-2">
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-8 px-2 bg-panel border border-line rounded text-xs outline-none focus:border-brand" />
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-8 px-2 bg-panel border border-line rounded text-xs outline-none focus:border-brand" />
            </div>
          }
        >
          <ResponsiveContainer
            width="100%"
            height="100%"
          >
            <LineChart data={monthly}>
              <CartesianGrid
                stroke="currentColor"
                strokeOpacity={0.15}
                strokeDasharray="3 3"
              />

              <XAxis
                dataKey="m"
                fontSize={11}
                stroke="currentColor"
                opacity={0.65}
                label={{ value: "Month / Year", position: "insideBottomRight", offset: -5, fontSize: 10, fill: "var(--muted)" }}
              />

              <YAxis
                fontSize={11}
                stroke="currentColor"
                opacity={0.65}
                label={{ value: "Number of FIRs", angle: -90, position: "insideLeft", fontSize: 10, fill: "var(--muted)" }}
              />

              <Tooltip content={<ChartTooltip />} />

              <Line
                dataKey="fir"
                stroke="currentColor"
                strokeWidth={2}
              />

              <Line
                dataKey="closed"
                stroke="currentColor"
                strokeDasharray="5 4"
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title={t(
            "Station workload",
            "ಠಾಣೆ ಕೆಲಸದ ಹೊರೆ"
          )}
        >
          <ResponsiveContainer
            width="100%"
            height="100%"
          >
            <BarChart data={station}>
              <CartesianGrid
                stroke="currentColor"
                strokeOpacity={0.15}
                strokeDasharray="3 3"
              />

              <XAxis
                dataKey="n"
                fontSize={10}
                stroke="currentColor"
                opacity={0.65}
                label={{ value: "Station", position: "insideBottomRight", offset: -5, fontSize: 10, fill: "var(--muted)" }}
              />

              <YAxis
                fontSize={11}
                stroke="currentColor"
                opacity={0.65}
                label={{ value: "Workload (FIRs)", angle: -90, position: "insideLeft", fontSize: 10, fill: "var(--muted)" }}
              />

              <Tooltip content={<ChartTooltip />} />

              <Bar
                dataKey="v"
                fill="currentColor"
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title={t(
            "Crime category breakdown",
            "ಅಪರಾಧ ವರ್ಗ ವಿಭಾಗ"
          )}
        >
          <ResponsiveContainer
            width="100%"
            height="100%"
          >
            <PieChart>
              <Pie
                data={pie}
                dataKey="value"
                nameKey="name"
                outerRadius={90}
                label
              >
                {pie.map((_, i) => (
                  <Cell
                    key={i}
                    fill="currentColor"
                    opacity={1 - i * 0.12}
                  />
                ))}
              </Pie>

              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <Card className="p-4">
          <div className="text-sm font-semibold">
            {t(
              "Performance summary",
              "ಕಾರ್ಯಕ್ಷಮತೆ ಸಾರಾಂಶ"
            )}
          </div>

          <div className="mt-4 space-y-4">
            {[
              [
                t(
                  "Cases disposed within 30 days",
                  "30 ದಿನಗಳಲ್ಲಿ ವಿಲೇವಾರಿ"
                ),
                disposedWithin30,
              ],
              [
                t(
                  "Charge sheets filed on time",
                  "ಸಮಯಕ್ಕೆ ಚಾರ್ಜ್‌ಶೀಟ್"
                ),
                chargeSheetFiledRate,
              ],
              [
                t(
                  "Investigation updates current",
                  "ತನಿಖಾ ನವೀಕರಣ ಪ್ರಸ್ತುತ"
                ),
                investigationCurrentRate,
              ],
            ].map((x) => (
              <div key={String(x[0])}>
                <div className="flex justify-between text-xs">
                  <span>{x[0]}</span>
                  <span>{x[1]}%</span>
                </div>

                <div className="h-2 bg-panel rounded-full mt-2">
                  <div
                    className="h-full bg-brand rounded-full"
                    style={{
                      width: `${x[1]}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        <ReferenceTable
          columns={["Status", "Cases", "Share"]}
          rows={statusRows}
          emptyText="No status data available."
        />
        <ReferenceTable
          columns={["Top Station", "Cases", "Share"]}
          rows={stationRows}
          emptyText="No station workload data available."
        />
      </div>
    </div>
  );
};

const ChartCard: React.FC<{
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, action, children }) => (
  <Card className="p-4">
    <div className="flex items-center justify-between">
      <div className="text-sm font-semibold">
        {title}
      </div>
      {action}
    </div>

    <div className="h-[260px] mt-4">
      {children}
    </div>
  </Card>
);

/* =========================================================
   REFERENCE PAGES
========================================================= */

export const Employees: React.FC = () => {
  const { records, loading, error } = useFirRecords();
  const groups = groupByKey(records, (record) => record.raw.EmployeeID || record.io);
  const rows = groups.map(([key, employeeCases]) => {
    const sample = employeeCases[0];
    const active = employeeCases.filter((record) => record.status === "Under Investigation").length;
    return [
      <div>
        <div className="font-semibold text-brand">{sample.raw.EmployeeID || key}</div>
        <div className="text-xs text-muted mt-1">{sample.io || "Officer name not captured"}</div>
      </div>,
      uniqueText(employeeCases.map((record) => record.raw.OfficerRank)),
      uniqueText(employeeCases.map((record) => record.raw.OfficerDesignation)),
      uniqueText(employeeCases.map((record) => record.station), "-"),
      employeeCases.length.toLocaleString("en-IN"),
      active.toLocaleString("en-IN"),
    ];
  });

  return (
    <div className="p-5 space-y-4">
      <ReferenceHeader
        title="Employees"
        description="Officer directory built from EmployeeID, officer name, rank, designation, and assigned cases."
        loading={loading}
        error={error}
        count={records.length}
      />
      <div className="grid md:grid-cols-3 gap-3">
        <ReferenceStat label="Employees" value={groups.length} helper="Unique employee IDs/officers" />
        <ReferenceStat label="Ranks" value={countByValue(records, "OfficerRank").length} />
        <ReferenceStat label="Designations" value={countByValue(records, "OfficerDesignation").length} />
      </div>
      <ReferenceTable
        columns={["Employee", "Rank", "Designation", "Stations", "Cases", "Active"]}
        rows={rows}
      />
    </div>
  );
};

export const MasterData: React.FC = () => {
  const { records, loading, error } = useFirRecords();
  const dataGroups = [
    ["Crime Heads", countByValue(records, "CrimeHead")],
    ["Crime Sub Heads", countByValue(records, "CrimeSubHead")],
    ["Acts", countByValue(records, "Acts", true)],
    ["Sections", countByValue(records, "Sections", true)],
    ["Statuses", countByValue(records, "Status")],
    ["Case Categories", countByValue(records, "CaseCategory")],
    ["Gravity", countByValue(records, "Gravity")],
    ["Chargesheet Status", countByValue(records, "ChargesheetStatus")],
  ] as const;

  const totalValues = dataGroups.reduce((sum, [, values]) => sum + values.length, 0);

  return (
    <div className="p-5 space-y-4">
      <ReferenceHeader
        title="Master Data"
        description="Crime, legal, status, category, and chargesheet reference values currently used by FIR records."
        loading={loading}
        error={error}
        count={records.length}
      />
      <div className="grid md:grid-cols-4 gap-3">
        <ReferenceStat label="Reference Values" value={totalValues} />
        <ReferenceStat label="Crime Heads" value={dataGroups[0][1].length} />
        <ReferenceStat label="Acts" value={dataGroups[2][1].length} />
        <ReferenceStat label="Sections" value={dataGroups[3][1].length} />
      </div>
      <div className="grid xl:grid-cols-2 gap-4">
        {dataGroups.map(([title, values]) => (
          <ReferenceListCard key={title} title={title} values={values} />
        ))}
      </div>
    </div>
  );
};

export const Units: React.FC = () => {
  const { records, loading, error } = useFirRecords();
  const groups = groupByKey(records, (record) => record.station);
  const rows = groups.map(([station, stationCases]) => {
    const active = stationCases.filter((record) => record.status === "Under Investigation").length;
    return [
      <div>
        <div className="font-semibold text-brand">{station}</div>
        <div className="text-xs text-muted mt-1">
          {uniqueText(stationCases.map((record) => record.raw.PoliceStationType))}
        </div>
      </div>,
      uniqueText(stationCases.map((record) => record.raw.District)),
      uniqueText(stationCases.map((record) => record.raw.Court)),
      stationCases.length.toLocaleString("en-IN"),
      active.toLocaleString("en-IN"),
    ];
  });

  return (
    <div className="p-5 space-y-4">
      <ReferenceHeader
        title="Units & Stations"
        description="Police station and unit reference data with current case workload."
        loading={loading}
        error={error}
        count={records.length}
      />
      <div className="grid md:grid-cols-4 gap-3">
        <ReferenceStat label="Stations" value={groups.length} />
        <ReferenceStat label="Station Types" value={countByValue(records, "PoliceStationType").length} />
        <ReferenceStat label="Districts" value={countByValue(records, "District").length} />
        <ReferenceStat
          label="Active Cases"
          value={records.filter((record) => record.status === "Under Investigation").length}
        />
      </div>
      <ReferenceTable
        columns={["Station / Unit", "District", "Courts Used", "Cases", "Active"]}
        rows={rows}
      />
    </div>
  );
};

export const Courts: React.FC = () => {
  const t = useT();
  const { records, loading, error } = useFirRecords();
  const groups = groupByKey(records, (record) => record.raw.Court);
  const courtRows = groups.map(([court, courtCases]) => {
    const filed = courtCases.filter((record) =>
      /^(filed|submitted|charge sheeted)$/i.test(record.raw.ChargesheetStatus || record.status),
    ).length;
    const pendingTrial = courtCases.filter((record) =>
      /pending trial/i.test(record.status),
    ).length;
    return {
      court,
      districts: uniqueTextValues(courtCases.map((record) => record.raw.District)),
      stations: uniqueTextValues(courtCases.map((record) => record.station)),
      cases: courtCases.length,
      filed,
      pendingTrial,
    };
  });
  const filedTotal = courtRows.reduce((sum, row) => sum + row.filed, 0);
  const pendingTotal = courtRows.reduce((sum, row) => sum + row.pendingTrial, 0);
  const locale = document.documentElement.lang === "kn" ? "kn-IN" : "en-IN";

  return (
    <div className="space-y-4 p-3 sm:p-5">
      <ReferenceHeader
        title={t("Courts", "ನ್ಯಾಯಾಲಯಗಳು")}
        description={t(
          "Court directory derived from FIR court mappings and chargesheet/trial status.",
          "ಎಫ್‌ಐಆರ್ ನ್ಯಾಯಾಲಯ ಮ್ಯಾಪಿಂಗ್ ಮತ್ತು ಆರೋಪಪಟ್ಟಿ/ವಿಚಾರಣೆಯ ಸ್ಥಿತಿಯಿಂದ ಪಡೆದ ನ್ಯಾಯಾಲಯ ಡೈರೆಕ್ಟರಿ.",
        )}
        loading={loading}
        error={error}
        count={records.length}
      />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <ReferenceStat label={t("Courts", "ನ್ಯಾಯಾಲಯಗಳು")} value={groups.length} />
        <ReferenceStat
          label={t("Filed Chargesheets", "ಸಲ್ಲಿಸಿದ ಆರೋಪಪಟ್ಟಿಗಳು")}
          value={filedTotal}
        />
        <ReferenceStat
          label={t("Pending Trial", "ವಿಚಾರಣೆ ಬಾಕಿ")}
          value={pendingTotal}
        />
        <ReferenceStat
          label={t("Mapped Stations", "ಮ್ಯಾಪ್ ಮಾಡಿದ ಠಾಣೆಗಳು")}
          value={countByValue(records, "PoliceStation").length}
        />
      </div>

      <div className="space-y-3 lg:hidden">
        {courtRows.map((row) => (
          <Card key={row.court} className="overflow-hidden p-4">
            <div className="font-semibold leading-6 text-brand [overflow-wrap:normal]">
              {row.court}
            </div>
            <div className="mt-1 text-xs text-muted">
              {row.districts.join(", ") || "-"}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {row.stations.slice(0, 5).map((station) => (
                <span key={station} className="rounded-full border border-line bg-panel px-2.5 py-1 text-[11px]">
                  {station}
                </span>
              ))}
              {row.stations.length > 5 && (
                <span className="rounded-full border border-brand/25 bg-brand/10 px-2.5 py-1 text-[11px] text-brand">
                  +{row.stations.length - 5} {t("more", "ಇನ್ನಷ್ಟು")}
                </span>
              )}
            </div>
            <div className="mt-4 grid grid-cols-3 divide-x divide-line rounded-lg border border-line bg-panel/40 py-2 text-center">
              {[
                [t("Cases", "ಪ್ರಕರಣಗಳು"), row.cases],
                [t("Filed CS", "ಸಲ್ಲಿಸಿದ ಆ.ಪ."), row.filed],
                [t("Pending", "ಬಾಕಿ"), row.pendingTrial],
              ].map(([label, value]) => (
                <div key={String(label)} className="px-2">
                  <div className="num text-base font-semibold">{Number(value).toLocaleString(locale)}</div>
                  <div className="mt-0.5 text-[10px] text-muted">{label}</div>
                </div>
              ))}
            </div>
          </Card>
        ))}
        {!loading && courtRows.length === 0 && (
          <Card className="p-8 text-center text-sm text-muted">
            {t("No court data found.", "ಯಾವುದೇ ನ್ಯಾಯಾಲಯದ ಮಾಹಿತಿ ಕಂಡುಬಂದಿಲ್ಲ.")}
          </Card>
        )}
      </div>

      <Card className="hidden overflow-hidden lg:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] table-fixed text-sm">
            <colgroup>
              <col className="w-[22%]" />
              <col className="w-[15%]" />
              <col className="w-[39%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-line bg-panel/40 text-left text-[10px] uppercase tracking-wide text-muted">
                {[
                  t("Court", "ನ್ಯಾಯಾಲಯ"),
                  t("District", "ಜಿಲ್ಲೆ"),
                  t("Stations", "ಠಾಣೆಗಳು"),
                  t("Cases", "ಪ್ರಕರಣಗಳು"),
                  t("Filed CS", "ಸಲ್ಲಿಸಿದ ಆ.ಪ."),
                  t("Pending Trial", "ವಿಚಾರಣೆ ಬಾಕಿ"),
                ].map((column, index) => (
                  <th
                    key={column}
                    className={`px-4 py-3 font-semibold [overflow-wrap:normal] ${index >= 3 ? "text-center" : ""
                      }`}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {courtRows.map((row) => (
                <tr key={row.court} className="border-b border-line last:border-0">
                  <td className="px-4 py-4 align-top font-semibold leading-6 text-brand [overflow-wrap:normal]">
                    {row.court}
                  </td>
                  <td className="px-4 py-4 align-top leading-6 [overflow-wrap:normal]">
                    {row.districts.join(", ") || "-"}
                  </td>
                  <td className="px-4 py-4 align-top">
                    <div className="flex flex-wrap gap-1.5" title={row.stations.join(", ")}>
                      {row.stations.slice(0, 8).map((station) => (
                        <span key={station} className="rounded-full border border-line bg-panel px-2 py-1 text-[11px] [overflow-wrap:normal]">
                          {station}
                        </span>
                      ))}
                      {row.stations.length > 8 && (
                        <span className="rounded-full border border-brand/25 bg-brand/10 px-2 py-1 text-[11px] text-brand">
                          +{row.stations.length - 8} {t("more", "ಇನ್ನಷ್ಟು")}
                        </span>
                      )}
                    </div>
                  </td>
                  {[row.cases, row.filed, row.pendingTrial].map((value, index) => (
                    <td key={index} className="num px-4 py-4 text-center align-top font-semibold">
                      {value.toLocaleString(locale)}
                    </td>
                  ))}
                </tr>
              ))}
              {!loading && courtRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted">
                    {t("No court data found.", "ಯಾವುದೇ ನ್ಯಾಯಾಲಯದ ಮಾಹಿತಿ ಕಂಡುಬಂದಿಲ್ಲ.")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

/* =========================================================
   SETTINGS
========================================================= */

const Toggle = ({ on, set }: { on: boolean; set: (v: boolean) => void }) => (
  <button
    type="button"
    aria-pressed={on}
    onClick={() => set(!on)}
    className={`relative h-5 w-10 shrink-0 rounded-full transition ${on ? "bg-brand" : "bg-panel border border-line"
      }`}
  >
    <span
      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition ${on ? "left-[22px]" : "left-0.5"
        }`}
    />
  </button>
);

const SettingRow = ({ title, desc, control }: { title: string; desc: string; control: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-5 py-4 border-b border-line last:border-b-0">
    <div className="min-w-0">
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-[11px] text-muted mt-1 leading-5">{desc}</div>
    </div>
    {control}
  </div>
);

export const Settings: React.FC = () => {
  const { user } = useAuth();
  const { language, setLanguage } = useLanguage();

  const t = useT();
  const nav = useNavigate();

  const [station, setStation] = useState(
    () =>
      localStorage.getItem(
        "kpfir.defaultStation"
      ) || "Whitefield PS"
  );

  const [newFir, setNewFir] = useState(
    () =>
      localStorage.getItem(
        "kpfir.notify.newFir"
      ) !== "false"
  );

  const [statusUpdates, setStatusUpdates] =
    useState(
      () =>
        localStorage.getItem(
          "kpfir.notify.status"
        ) !== "false"
    );

  const [savedMessage, setSavedMessage] =
    useState("");

  const { reload: reloadCases } = useCases();
  const [pullState, setPullState] = useState<{
    status: "idle" | "pulling" | "success" | "error";
    message: string;
  }>({ status: "idle", message: "" });

  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [phoneRecordLoading, setPhoneRecordLoading] = useState(true);
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [phoneError, setPhoneError] = useState("");
  const [phoneSuccess, setPhoneSuccess] = useState("");
  const [smsConfigured, setSmsConfigured] = useState<boolean | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const employeeId = user?.employeeId;
    setPhoneRecordLoading(true);
    setPhoneVerified(false);
    setPhoneNumber("");
    setOtp("");
    setOtpSent(false);
    setResendSeconds(0);
    setPhoneError("");
    setPhoneSuccess("");
    setSmsConfigured(null);

    if (!employeeId) {
      setPhoneRecordLoading(false);
      return () => {
        cancelled = true;
      };
    }

    void fetch(`/api/phone?employeeId=${encodeURIComponent(employeeId)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok) {
          throw new Error(data?.error || "Unable to load the saved phone number.");
        }
        if (cancelled) return;

        const digits = String(data.phoneNumber || "").replace(/\D/g, "").slice(-10);
        const verified = Boolean(data.verified && /^[6-9]\d{9}$/.test(digits));
        if (data.preferences) {
          const savedNewFir = Boolean(data.preferences.newFir);
          const savedStatusUpdates = Boolean(data.preferences.statusUpdates);
          setNewFir(savedNewFir);
          setStatusUpdates(savedStatusUpdates);
          localStorage.setItem("kpfir.notify.newFir", String(savedNewFir));
          localStorage.setItem("kpfir.notify.status", String(savedStatusUpdates));
        }
        setSmsConfigured(Boolean(data.sms?.configured));
        setPhoneNumber(verified ? digits : "");
        setPhoneVerified(verified);
        if (verified) {
          localStorage.setItem(`kpfir.phoneNumber.${employeeId}`, `+91${digits}`);
          localStorage.setItem(`kpfir.phoneVerified.${employeeId}`, "true");
        } else {
          localStorage.removeItem(`kpfir.phoneNumber.${employeeId}`);
          localStorage.removeItem(`kpfir.phoneVerified.${employeeId}`);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPhoneError(error instanceof Error ? error.message : "Unable to load the saved phone number.");
        }
      })
      .finally(() => {
        if (!cancelled) setPhoneRecordLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.employeeId]);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setInterval(
      () => setResendSeconds((seconds) => Math.max(0, seconds - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [resendSeconds > 0]);

  const handlePhoneNumberChange = (value: string) => {
    const digits = value.replace(/\D/g, "").slice(0, 10);
    if (digits !== phoneNumber && otpSent) {
      setOtp("");
      setOtpSent(false);
      setResendSeconds(0);
      setPhoneSuccess("");
    }
    setPhoneNumber(digits);
    setPhoneError("");
  };

  const sendOtp = async () => {
    setPhoneError("");
    setPhoneSuccess("");

    if (!user?.employeeId) {
      setPhoneError(t("Please sign in again.", "ದಯವಿಟ್ಟು ಮತ್ತೆ ಸೈನ್ ಇನ್ ಮಾಡಿ."));
      return;
    }
    if (!/^[6-9]\d{9}$/.test(phoneNumber)) {
      setPhoneError(
        t(
          "Enter a valid 10-digit Indian mobile number.",
          "ಮಾನ್ಯವಾದ 10 ಅಂಕಿಯ ಭಾರತೀಯ ಮೊಬೈಲ್ ಸಂಖ್ಯೆಯನ್ನು ನಮೂದಿಸಿ.",
        ),
      );
      return;
    }

    setPhoneLoading(true);
    try {
      const res = await fetch("/api/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: user.employeeId,
          phoneNumber: `+91${phoneNumber}`,
        }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.ok) {
        if (Number.isFinite(data?.retryAfterSeconds)) {
          setResendSeconds(data.retryAfterSeconds);
        }
        throw new Error(
          data?.error || t("Failed to send OTP.", "OTP ಕಳುಹಿಸಲು ವಿಫಲವಾಗಿದೆ."),
        );
      }

      setOtp("");
      setOtpSent(true);
      setResendSeconds(Number(data.retryAfterSeconds) || 60);
      setPhoneSuccess(
        t(
          `A 6-digit OTP was sent. It expires in ${Math.max(1, Math.ceil(Number(data.expiresInSeconds || 300) / 60))} minutes.`,
          "6 ಅಂಕಿಯ OTP ಕಳುಹಿಸಲಾಗಿದೆ. ಇದು 5 ನಿಮಿಷಗಳಲ್ಲಿ ಅವಧಿ ಮೀರುತ್ತದೆ.",
        ),
      );
    } catch (err) {
      setPhoneError(
        err instanceof Error
          ? err.message
          : t("Failed to send OTP.", "OTP ಕಳುಹಿಸಲು ವಿಫಲವಾಗಿದೆ."),
      );
    } finally {
      setPhoneLoading(false);
    }
  };

  const verifyOtp = async () => {
    setPhoneError("");
    setPhoneSuccess("");

    if (!user?.employeeId) {
      setPhoneError(t("Please sign in again.", "ದಯವಿಟ್ಟು ಮತ್ತೆ ಸೈನ್ ಇನ್ ಮಾಡಿ."));
      return;
    }
    if (!/^\d{6}$/.test(otp)) {
      setPhoneError(t("Enter the 6-digit OTP.", "6 ಅಂಕಿಯ OTP ನಮೂದಿಸಿ."));
      return;
    }

    setPhoneLoading(true);
    try {
      const verifiedNumber = `+91${phoneNumber}`;
      const res = await fetch("/api/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: user.employeeId,
          phoneNumber: verifiedNumber,
          otp,
        }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.ok) {
        if (
          ["OTP_EXPIRED", "OTP_NOT_FOUND", "OTP_ATTEMPTS_EXHAUSTED"].includes(
            String(data?.code || ""),
          )
        ) {
          setOtpSent(false);
          setOtp("");
        }
        throw new Error(
          data?.error ||
          t("Failed to verify OTP.", "OTP ದೃಢೀಕರಿಸಲು ವಿಫಲವಾಗಿದೆ."),
        );
      }

      setOtp("");
      setOtpSent(false);
      setResendSeconds(0);
      setPhoneSuccess(
        t(
          "Phone number verified and saved.",
          "ಫೋನ್ ಸಂಖ್ಯೆಯನ್ನು ದೃಢೀಕರಿಸಿ ಉಳಿಸಲಾಗಿದೆ.",
        ),
      );
      localStorage.setItem(
        `kpfir.phoneNumber.${user.employeeId}`,
        verifiedNumber,
      );
      localStorage.setItem(`kpfir.phoneVerified.${user.employeeId}`, "true");
      setPhoneVerified(true);
    } catch (err) {
      setPhoneError(
        err instanceof Error
          ? err.message
          : t("Failed to verify OTP.", "OTP ದೃಢೀಕರಿಸಲು ವಿಫಲವಾಗಿದೆ."),
      );
    } finally {
      setPhoneLoading(false);
    }
  };

  const changePhoneNumber = () => {
    if (user?.employeeId) {
      localStorage.removeItem(`kpfir.phoneNumber.${user.employeeId}`);
      localStorage.removeItem(`kpfir.phoneVerified.${user.employeeId}`);
    }
    localStorage.removeItem("kpfir.phoneNumber");
    setPhoneNumber("");
    setOtp("");
    setOtpSent(false);
    setResendSeconds(0);
    setPhoneError("");
    setPhoneSuccess("");
    setPhoneVerified(false);
  };

  const pullFromMaster = async () => {
    setPullState({
      status: "pulling",
      message: "Pulling latest cases from Google Master Sheet...",
    });

    try {
      const data = await pullCasesFromMaster();
      await reloadCases(true);
      const count = data.cases?.length || 0;
      setPullState({
        status: "success",
        message: data.writeResult?.pending
          ? `Pulled ${count} cases into a pending local copy. Refresh once so it can be promoted.`
          : `Pulled ${count} cases successfully.`,
      });
    } catch (err) {
      setPullState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const save = async () => {
    setSettingsError("");
    setSavedMessage("");
    if (!user?.employeeId) {
      setSettingsError(t("Please sign in again.", "ದಯವಿಟ್ಟು ಮತ್ತೆ ಸೈನ್ ಇನ್ ಮಾಡಿ."));
      return;
    }

    setSettingsSaving(true);
    try {
      const response = await fetch("/api/notification-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: user.employeeId,
          newFir,
          statusUpdates,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Unable to save notification preferences.");
      }

      const savedNewFir = Boolean(data.preferences?.newFir);
      const savedStatusUpdates = Boolean(data.preferences?.statusUpdates);
      setNewFir(savedNewFir);
      setStatusUpdates(savedStatusUpdates);
      localStorage.setItem("kpfir.defaultStation", station);
      localStorage.setItem("kpfir.notify.newFir", String(savedNewFir));
      localStorage.setItem("kpfir.notify.status", String(savedStatusUpdates));
      setSavedMessage(t("Changes saved", "ಬದಲಾವಣೆಗಳನ್ನು ಉಳಿಸಲಾಗಿದೆ"));
      window.setTimeout(() => setSavedMessage(""), 2200);
    } catch (error) {
      setSettingsError(
        error instanceof Error
          ? error.message
          : t("Unable to save changes.", "ಬದಲಾವಣೆಗಳನ್ನು ಉಳಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ."),
      );
    } finally {
      setSettingsSaving(false);
    }
  };



  return (
    <div className="p-5 pb-20 space-y-5 max-w-6xl mx-auto w-full">
      <div className="text-center">
        <h1 className="text-xl font-semibold">
          {t("Settings", "ಸೆಟ್ಟಿಂಗ್‌ಗಳು")}
        </h1>

        <p className="text-sm text-muted mt-1">
          {t(
            "Manage your workspace, alerts and account.",
            "ನಿಮ್ಮ ಕಾರ್ಯಸ್ಥಳ, ಎಚ್ಚರಿಕೆಗಳು ಮತ್ತು ಖಾತೆಯನ್ನು ನಿರ್ವಹಿಸಿ."
          )}
        </p>
      </div>

      <div className="grid xl:grid-cols-2 gap-4">


        <Card className="p-5 settings-card">
          <h2 className="font-semibold">
            {t(
              "Notifications",
              "ಸೂಚನೆಗಳು"
            )}
          </h2>

          <p className="text-xs text-muted mt-1">
            {t(
              "Update your phone number and notification preferences.",
              "ನಿಮ್ಮ ಫೋನ್ ಸಂಖ್ಯೆ ಮತ್ತು ಸೂಚನೆ ಆದ್ಯತೆಗಳನ್ನು ನವೀಕರಿಸಿ."
            )}
          </p>

          <div className="mt-3">
            <SettingRow
              title={t("Phone Number", "ಫೋನ್ ಸಂಖ್ಯೆ")}
              desc={t(
                "Used for SMS alerts and verification.",
                "SMS ಎಚ್ಚರಿಕೆಗಳು ಮತ್ತು ದೃಢೀಕರಣಕ್ಕಾಗಿ ಬಳಸಲಾಗುತ್ತದೆ.",
              )}
              control={
                <div className="flex flex-col gap-2 min-w-[240px]">
                  {phoneRecordLoading ? (
                    <div className="text-xs text-muted">
                      {t("Loading phone number…", "ಫೋನ್ ಸಂಖ್ಯೆಯನ್ನು ಲೋಡ್ ಮಾಡಲಾಗುತ್ತಿದೆ…")}
                    </div>
                  ) : phoneVerified ? (
                    <div className="flex items-center gap-2 text-sage text-sm font-medium">
                      ✓ +91 {phoneNumber} {t("Verified", "ದೃಢೀಕರಿಸಲಾಗಿದೆ")}
                      <button
                        type="button"
                        onClick={changePhoneNumber}
                        className="text-muted text-xs ml-4 hover:text-white underline"
                      >
                        {t("Change", "ಬದಲಾಯಿಸಿ")}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <div className="flex items-center gap-2 flex-1 h-9 bg-panel border border-line rounded-lg px-3 focus-within:border-brand transition">
                          <span className="text-xs text-muted font-medium">+91</span>
                          <input
                            type="tel"
                            inputMode="numeric"
                            autoComplete="tel-national"
                            aria-label={t("Mobile number", "ಮೊಬೈಲ್ ಸಂಖ್ಯೆ")}
                            value={phoneNumber}
                            disabled={otpSent || phoneLoading}
                            onChange={(event) => handlePhoneNumberChange(event.target.value)}
                            placeholder="9876543210"
                            className="flex-1 bg-transparent text-xs outline-none disabled:opacity-70"
                          />
                        </div>
                        {!otpSent && (
                          <button
                            type="button"
                            onClick={sendOtp}
                            disabled={
                              phoneLoading ||
                              resendSeconds > 0 ||
                              !/^[6-9]\d{9}$/.test(phoneNumber)
                            }
                            className="h-9 px-3 bg-brand rounded-lg text-xs font-medium disabled:opacity-60 whitespace-nowrap"
                          >
                            {phoneLoading
                              ? t("Sending…", "ಕಳುಹಿಸಲಾಗುತ್ತಿದೆ…")
                              : resendSeconds > 0
                                ? `${t("Retry in", "ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ")} ${resendSeconds}s`
                                : t("Send OTP", "OTP ಕಳುಹಿಸಿ")}
                          </button>
                        )}
                      </div>
                      {otpSent && (
                        <>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              aria-label={t("6-digit OTP", "6 ಅಂಕಿಯ OTP")}
                              value={otp}
                              onChange={(event) =>
                                setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && /^\d{6}$/.test(otp)) {
                                  void verifyOtp();
                                }
                              }}
                              placeholder="123456"
                              className="flex-1 h-9 bg-panel border border-line rounded-lg px-3 text-xs tracking-[0.25em] outline-none"
                            />
                            <button
                              type="button"
                              onClick={verifyOtp}
                              disabled={phoneLoading || !/^\d{6}$/.test(otp)}
                              className="h-9 px-3 bg-sage text-white rounded-lg text-xs font-medium disabled:opacity-60 whitespace-nowrap"
                            >
                              {phoneLoading
                                ? t("Verifying…", "ದೃಢೀಕರಿಸಲಾಗುತ್ತಿದೆ…")
                                : t("Verify", "ದೃಢೀಕರಿಸಿ")}
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={sendOtp}
                            disabled={phoneLoading || resendSeconds > 0}
                            className="self-start text-[10px] text-muted underline disabled:no-underline disabled:opacity-60"
                          >
                            {resendSeconds > 0
                              ? `${t("Resend available in", "ಮರುಕಳುಹಿಸಲು ಲಭ್ಯ")} ${resendSeconds}s`
                              : t("Resend OTP", "OTP ಮರುಕಳುಹಿಸಿ")}
                          </button>
                        </>
                      )}
                    </>
                  )}
                  {phoneError && (
                    <div role="alert" className="text-rose text-[10px]">
                      {phoneError}
                    </div>
                  )}
                  {phoneSuccess && (
                    <div role="status" className="text-sage text-[10px]">
                      {phoneSuccess}
                    </div>
                  )}
                </div>
              }
            />
            {smsConfigured !== null && (
              <div
                role={smsConfigured ? "status" : "alert"}
                className={`my-3 rounded-lg border px-3 py-2 text-[11px] ${smsConfigured
                    ? "border-sage/30 bg-sage/10 text-sage"
                    : "border-rose/30 bg-rose/10 text-rose"
                  }`}
              >
                {smsConfigured
                  ? phoneVerified
                    ? t(
                      "SMS delivery is connected and your verified number can receive enabled alerts.",
                      "SMS ವಿತರಣೆ ಸಂಪರ್ಕಗೊಂಡಿದೆ ಮತ್ತು ನಿಮ್ಮ ದೃಢೀಕೃತ ಸಂಖ್ಯೆ ಸಕ್ರಿಯ ಎಚ್ಚರಿಕೆಗಳನ್ನು ಸ್ವೀಕರಿಸಬಹುದು.",
                    )
                    : t(
                      "SMS delivery is connected. Verify a phone number to receive alerts.",
                      "SMS ವಿತರಣೆ ಸಂಪರ್ಕಗೊಂಡಿದೆ. ಎಚ್ಚರಿಕೆಗಳನ್ನು ಪಡೆಯಲು ಫೋನ್ ಸಂಖ್ಯೆಯನ್ನು ದೃಢೀಕರಿಸಿ.",
                    )
                  : t(
                    "SMS delivery is not configured on the server.",
                    "ಸರ್ವರ್‌ನಲ್ಲಿ SMS ವಿತರಣೆಯನ್ನು ಕಾನ್ಫಿಗರ್ ಮಾಡಲಾಗಿಲ್ಲ.",
                  )}
              </div>
            )}
            <SettingRow
              title={t(
                "New FIR Alerts",
                "ಹೊಸ ಎಫ್‌ಐಆರ್ ಎಚ್ಚರಿಕೆಗಳು"
              )}
              desc={t(
                "Notify me when a new FIR is registered in my unit.",
                "ನನ್ನ ಘಟಕದಲ್ಲಿ ಹೊಸ ಎಫ್‌ಐಆರ್ ನೋಂದಾಯಿಸಿದಾಗ ಸೂಚಿಸಿ."
              )}
              control={
                <Toggle
                  on={newFir}
                  set={setNewFir}
                />
              }
            />

            <SettingRow
              title={t(
                "Case Status Updates",
                "ಪ್ರಕರಣ ಸ್ಥಿತಿ ನವೀಕರಣಗಳು"
              )}
              desc={t(
                "Alert me when an assigned case changes status.",
                "ನಿಯೋಜಿತ ಪ್ರಕರಣದ ಸ್ಥಿತಿ ಬದಲಾದಾಗ ಎಚ್ಚರಿಸಿ."
              )}
              control={
                <Toggle
                  on={statusUpdates}
                  set={setStatusUpdates}
                />
              }
            />
          </div>
        </Card>

        <Card className="p-5 settings-card xl:col-span-2">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold">
                Sync Sheet
              </h2>
            </div>

            <button
              type="button"
              onClick={pullFromMaster}
              disabled={pullState.status === "pulling"}
              className="h-10 px-4 rounded-lg bg-brand text-white text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {pullState.status === "pulling"
                ? "Syncing..."
                : "Pull Latest"}
            </button>
          </div>

          {pullState.message && (
            <div
              className={`mt-4 rounded-lg border px-3 py-2 text-xs ${pullState.status === "error"
                  ? "border-red-200 bg-red-50 text-red-700"
                  : pullState.status === "success"
                    ? "border-green-200 bg-green-50 text-green-700"
                    : "border-line bg-panel text-muted"
                }`}
            >
              {pullState.message}
            </div>
          )}
        </Card>

        <Card className="p-5 settings-card xl:col-span-2">
          <h2 className="font-semibold">
            {t(
              "Account & Security",
              "ಖಾತೆ ಮತ್ತು ಭದ್ರತೆ"
            )}
          </h2>

          <p className="text-xs text-muted mt-1">
            {t(
              "Your officer account and password settings.",
              "ನಿಮ್ಮ ಅಧಿಕಾರಿ ಖಾತೆ ಮತ್ತು ಪಾಸ್‌ವರ್ಡ್ ಸೆಟ್ಟಿಂಗ್‌ಗಳು."
            )}
          </p>

          <div className="mt-5 flex flex-col md:flex-row md:items-center justify-between gap-5">
            <div>
              <div className="text-sm font-semibold">
                {user?.name || "Officer 10427"}
              </div>

              <div className="text-xs text-muted mt-1">
                {user?.employeeId ||
                  "KA-SI-10427"}
              </div>
            </div>

            <button
              onClick={() =>
                nav("/change-password")
              }
              className="h-10 px-4 border border-line rounded-lg text-sm font-semibold hover:border-brand/40"
            >
              {t(
                "Change password",
                "ಪಾಸ್‌ವರ್ಡ್ ಬದಲಿಸಿ"
              )}
            </button>
          </div>
        </Card>
      </div>

      <div className="flex items-center justify-end gap-3">
        {settingsError && (
          <span role="alert" className="text-sm text-rose">
            {settingsError}
          </span>
        )}
        {savedMessage && (
          <span className="text-sm text-brand">
            ✓ {savedMessage}
          </span>
        )}

        <button
          onClick={() => void save()}
          disabled={settingsSaving}
          className="h-10 px-5 rounded-lg bg-brand text-white text-sm font-semibold disabled:opacity-60"
        >
          {settingsSaving
            ? t("Saving…", "ಉಳಿಸಲಾಗುತ್ತಿದೆ…")
            : t("Save changes", "ಬದಲಾವಣೆಗಳನ್ನು ಉಳಿಸಿ")}
        </button>
      </div>
    </div>
  );
};
