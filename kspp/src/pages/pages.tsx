import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Activity, ArrowRight, Building2, Gavel, MapPin, Search, Scale } from "lucide-react";

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
import { displayKnownValue } from "../lib/kannadaValues";
import { displayPlaceName } from "../lib/kannadaPlaces";
import CasePassQR from "../components/CasePassQR";
import { CriminalNetworkGraph } from "../components/search/CriminalNetworkGraph";
import { buildCriminalNetwork } from "../lib/criminalNetwork";
import { recordAuditEvent } from "../lib/audit";
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

const useT = () => useLanguage().tr;

const Card: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = "" }) => (
  <div className={`bg-shell border border-line rounded-xl ${className}`}>
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
}> = ({ columns, rows, emptyText }) => {
  const t = useT();
  const resolvedEmptyText = emptyText || t("No reference data found.", "ಯಾವುದೇ ಉಲ್ಲೇಖ ದತ್ತಾಂಶ ಕಂಡುಬಂದಿಲ್ಲ.");
  return (
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
                  {resolvedEmptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
};

const ReferenceListCard: React.FC<{
  title: string;
  values: Array<{ name: string; count: number }>;
}> = ({ title, values }) => {
  const { language, tr: t } = useLanguage();
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-muted">{values.length} {t("values", "ಮೌಲ್ಯಗಳು")}</div>
      </div>
      <div className="mt-4 max-h-72 overflow-auto space-y-2 pr-1">
        {values.map((item) => (
          <div
            key={item.name}
            className="flex items-start justify-between gap-4 rounded-lg border border-line bg-panel/40 px-3 py-2"
          >
            <span className="text-sm">{displayKnownValue(item.name, language)}</span>
            <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
              {item.count}
            </span>
          </div>
        ))}
        {values.length === 0 && <div className="text-sm text-muted">{t("No values found.", "ಯಾವುದೇ ಮೌಲ್ಯಗಳು ಕಂಡುಬಂದಿಲ್ಲ.")}</div>}
      </div>
    </Card>
  );
};

/* =========================================================
   CHART TOOLTIP
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
  const { language, tr: t } = useLanguage();
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
        const label = d.toLocaleDateString(language === "kn" ? "kn-IN" : "en-IN", { month: "short", year: "numeric" });
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
          day: d.toLocaleDateString(language === "kn" ? "kn-IN" : "en-IN", { day: "2-digit", month: "short" }),
          fir: dayRecords.length,
          solved: dayRecords.filter((record) => closedStatuses.includes(record.status)).length,
        });
      }
      return days;
    }
  }, [filteredRecords, fromDate, toDate, language]);

  const liveAttention = filteredRecords
    .filter((record) => record.status === "Under Investigation" || record.gravity === "Heinous")
    .slice(0, 3)
    .map((record) => [
      caseRoute(record.raw),
      record.label,
      displayKnownValue(record.status || record.gravity || record.category, language),
    ]);
  const attentionRows = liveAttention;
  const metricFooters = [
    t("loaded from Consolidated_Cases", "Consolidated_Cases ನಿಂದ ಲೋಡ್ ಆಗಿದೆ"),
    t("currently under investigation", "ಪ್ರಸ್ತುತ ತನಿಖೆಯಲ್ಲಿದೆ"),
    t("without filed chargesheet", "ಸಲ್ಲಿಸಿದ ಆರೋಪಪಟ್ಟಿ ಇಲ್ಲದೆ"),
    t("marked heinous", "ಗಂಭೀರ ಎಂದು ಗುರುತಿಸಲಾಗಿದೆ"),
  ];
  const dashboardSubtitles = [
    t(`${assignedRecords.length} assigned to current login`, `ಪ್ರಸ್ತುತ ಲಾಗಿನ್‌ಗೆ ${assignedRecords.length} ನಿಯೋಜಿಸಲಾಗಿದೆ`),
    t(`${disposedCases} disposed / charge-sheeted`, `${disposedCases} ವಿಲೇವಾರಿ / ಆರೋಪಪಟ್ಟಿ ಸಲ್ಲಿಸಲಾಗಿದೆ`),
    t("days from registration to latest case state", "ನೋಂದಣಿಯಿಂದ ಇತ್ತೀಚಿನ ಪ್ರಕರಣ ಸ್ಥಿತಿವರೆಗಿನ ದಿನಗಳು"),
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

                <Tooltip content={<ChartTooltip />} />

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
                {t("No cases currently require attention.", "ಪ್ರಸ್ತುತ ಗಮನ ಅಗತ್ಯವಿರುವ ಪ್ರಕರಣಗಳಿಲ್ಲ.")}
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
  const { language, tr: t } = useLanguage();
  const nav = useNavigate();
  const { records, loading, error, reload } = useFirRecords();
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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
            className="bg-brand rounded-lg px-4 h-9 text-sm text-white font-semibold"
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
            {t("Loading FIR records…", "ಎಫ್‌ಐಆರ್ ದಾಖಲೆಗಳು ಲೋಡ್ ಆಗುತ್ತಿವೆ…")}
          </div>
        )}
        {error && (
          <div className="mt-5 rounded-lg border border-rose/30 bg-rose/10 p-4 text-sm text-rose" role="alert">
            <p>{navigator.onLine ? error : t("You are offline. Reconnect and try again.", "ನೀವು ಆಫ್‌ಲೈನ್‌ನಲ್ಲಿದ್ದೀರಿ. ಮರುಸಂಪರ್ಕಿಸಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.")}</p>
            <button type="button" onClick={() => void reload()} className="mt-3 rounded-lg border border-rose/40 px-3 py-2 text-xs font-semibold">{t("Try again", "ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ")}</button>
          </div>
        )}
        {!loading && !error && visibleRecords.length === 0 && (
          <div className="mt-5 rounded-lg border border-line p-4 text-sm text-muted">
            {t("No FIR records match the selected filters.", "ಆಯ್ಕೆ ಮಾಡಿದ ಫಿಲ್ಟರ್‌ಗಳಿಗೆ ಹೊಂದುವ ಎಫ್‌ಐಆರ್ ದಾಖಲೆಗಳಿಲ್ಲ.")}
          </div>
        )}

        <div className="mt-5 space-y-3 md:hidden">
          {pageRecords.map((record) => (
            <button
              type="button"
              key={record.id}
              onClick={() => nav(`/fir/${caseRoute(record.raw)}`)}
              className="w-full rounded-xl border border-line bg-panel/40 p-4 text-left transition hover:border-brand/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-brand">{record.label}</div>
                  <div className="mt-1 break-all text-[11px] text-muted num">{record.fir || t("Number pending", "ಸಂಖ್ಯೆ ಬಾಕಿ")}</div>
                </div>
                <span className="shrink-0 rounded-full border border-line px-2 py-1 text-[10px]">
                  {displayKnownValue(record.status, language)}
                </span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
                <div><dt className="text-muted">{t("Category", "ವರ್ಗ")}</dt><dd className="mt-0.5 font-medium">{displayKnownValue(record.category, language)}</dd></div>
                <div><dt className="text-muted">{t("Registered", "ನೋಂದಣಿ")}</dt><dd className="mt-0.5 font-medium">{record.date || "—"}</dd></div>
                <div><dt className="text-muted">{t("Station", "ಠಾಣೆ")}</dt><dd className="mt-0.5 font-medium">{displayPlaceName(record.station, language) || "—"}</dd></div>
                <div><dt className="text-muted">{t("IO", "ತನಿಖಾಧಿಕಾರಿ")}</dt><dd className="mt-0.5 font-medium">{record.io || "—"}</dd></div>
              </dl>
              <div className="mt-4 text-right text-xs font-semibold text-brand">{t("Open case", "ಪ್ರಕರಣ ತೆರೆಯಿರಿ")} ›</div>
            </button>
          ))}
        </div>

        <div className="mt-5 hidden overflow-x-auto md:block">
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

                <th>{t("IO", "ತನಿಖಾಧಿಕಾರಿ")}</th>

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

                  <td>{displayKnownValue(r.category, language)}</td>
                  <td>{displayPlaceName(r.station, language)}</td>
                  <td>{r.io}</td>
                  <td>{r.date}</td>

                  <td>
                    <span className="text-xs border border-line rounded-full px-2 py-1">
                      {displayKnownValue(r.status, language)}
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
              {t("Showing", "ತೋರಿಸಲಾಗುತ್ತಿದೆ")} {(page - 1) * pageSize + 1}–
              {Math.min(page * pageSize, visibleRecords.length)} {t("of", "ರಲ್ಲಿ")} {visibleRecords.length}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page === 1}
                className="rounded-lg border border-line px-3 py-2 disabled:opacity-40"
              >
                {t("Previous", "ಹಿಂದಿನದು")}
              </button>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                disabled={page === pageCount}
                className="rounded-lg border border-line px-3 py-2 disabled:opacity-40"
              >
                {t("Next", "ಮುಂದಿನದು")}
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
  const { language, tr: t } = useLanguage();
  const { id } = useParams();
  const nav = useNavigate();
  const { cases, loading, error } = useFirRecords();

  const [showQR, setShowQR] = useState(false);

  const matchedCase = findCase(cases, id);
  const r = matchedCase ? toFirRecord(matchedCase) : undefined;

  if (loading) {
    return <div className="p-5 text-sm text-muted">{t("Loading case from Google Sheets...", "Google Sheets ನಿಂದ ಪ್ರಕರಣ ಲೋಡ್ ಆಗುತ್ತಿದೆ...")}</div>;
  }

  if (error) {
    return <div className="p-5 text-sm text-rose">{error}</div>;
  }

  if (!r) {
    return <div className="p-5 text-sm text-muted">{t("Case not found in Google Sheets.", "Google Sheets ನಲ್ಲಿ ಪ್ರಕರಣ ಕಂಡುಬಂದಿಲ್ಲ.")}</div>;
  }

  const liveTimeline = [
    r.raw.CrimeRegisteredDate
      ? [
        t("FIR Registered", "ಎಫ್‌ಐಆರ್ ನೋಂದಾಯಿಸಲಾಗಿದೆ"),
        r.raw.CrimeRegisteredDate,
        r.raw.FiledBy ? t(`Filed by ${r.raw.FiledBy}`, `${r.raw.FiledBy} ಸಲ್ಲಿಸಿದ್ದಾರೆ`) : t("Registration recorded", "ನೋಂದಣಿ ದಾಖಲಿಸಲಾಗಿದೆ"),
      ]
      : null,
    r.raw.InfoReceivedPSDate
      ? [
        t("Information received", "ಮಾಹಿತಿ ಸ್ವೀಕರಿಸಲಾಗಿದೆ"),
        r.raw.InfoReceivedPSDate,
        r.station || t("Police station", "ಪೊಲೀಸ್ ಠಾಣೆ"),
      ]
      : null,
    r.raw.IncidentFromDate
      ? [
        t("Incident period", "ಘಟನೆಯ ಅವಧಿ"),
        [r.raw.IncidentFromDate, r.raw.IncidentToDate].filter(Boolean).join(" – "),
        r.raw.BriefFacts || t("Incident details recorded", "ಘಟನೆಯ ವಿವರಗಳು ದಾಖಲಾಗಿವೆ"),
      ]
      : null,
    r.io
      ? [
        t("Investigating officer assigned", "ತನಿಖಾಧಿಕಾರಿ ನಿಯೋಜಿಸಲಾಗಿದೆ"),
        r.raw.CrimeRegisteredDate || t("Date not recorded", "ದಿನಾಂಕ ದಾಖಲಾಗಿಲ್ಲ"),
        r.io,
      ]
      : null,
    r.raw.LatestChargesheetDate || r.raw.ChargesheetStatus
      ? [
        t("Chargesheet status", "ಆರೋಪಪಟ್ಟಿ ಸ್ಥಿತಿ"),
        r.raw.LatestChargesheetDate || t("Date not recorded", "ದಿನಾಂಕ ದಾಖಲಾಗಿಲ್ಲ"),
        r.raw.ChargesheetStatus || t("Status not recorded", "ಸ್ಥಿತಿ ದಾಖಲಾಗಿಲ್ಲ"),
      ]
      : null,
  ].filter((item): item is string[] => Boolean(item));

  return (
    <div className="p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs text-brand">
            {r.label}
          </div>

          <h1 className="text-xl font-semibold mt-1">
            {displayKnownValue(r.category, language)}
          </h1>

          <p className="text-sm text-muted">
            {displayPlaceName(r.station, language)} · {displayKnownValue(r.status, language)}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowQR(true)}
            className="h-9 px-3 rounded-lg border border-line bg-shell text-xs font-semibold hover:border-brand/40 transition flex items-center gap-1.5"
          >
            <span>📱</span>
            {t("Case Pass QR", "ಕೇಸ್ ಪಾಸ್ QR")}
          </button>
          <button
            type="button"
            onClick={() => nav(`/fir/${caseRoute(r.raw)}/edit`)}
            className="h-9 px-3 rounded-lg bg-brand text-white text-xs font-semibold hover:opacity-90 transition"
          >
            {t("Edit", "ಸಂಪಾದಿಸಿ")}
          </button>
        </div>
      </div>

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
                displayKnownValue(r.gravity, language),
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
              <p className="text-sm text-muted">{t("No dated case events are recorded.", "ದಿನಾಂಕ ಹೊಂದಿರುವ ಯಾವುದೇ ಪ್ರಕರಣ ಘಟನೆಗಳು ದಾಖಲಾಗಿಲ್ಲ.")}</p>
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

      {showQR && (
        <CasePassQR
          record={r.raw}
          onClose={() => setShowQR(false)}
        />
      )}
    </div>
  );
};

/* =========================================================
   ADVANCED SEARCH
========================================================= */

export const AdvancedSearch: React.FC = () => {
  const { language, tr: t } = useLanguage();
  const [searchParams] = useSearchParams();

  const [q, setQ] = useState(() => searchParams.get("q") || "");
  const [station, setStation] = useState(() => searchParams.get("station") || "");
  const [status, setStatus] = useState(() => searchParams.get("status") || "");
  const [page, setPage] = useState(1);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [showNetwork, setShowNetwork] = useState(false);
  const pageSize = 25;

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

  const { records, options, loading, error, reload } = useFirRecords();
  const selectedRecord = useMemo(
    () => records.find((record) => record.id === selectedCaseId),
    [records, selectedCaseId],
  );
  const criminalNetwork = useMemo(
    () => (selectedRecord ? buildCriminalNetwork(selectedRecord, records) : null),
    [records, selectedRecord],
  );

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
  const pageCount = Math.max(1, Math.ceil(results.length / pageSize));
  const pageResults = results.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    setPage(1);
    setSelectedCaseId("");
    setShowNetwork(false);
  }, [q, station, status]);

  useEffect(() => {
    if (selectedCaseId && !selectedRecord && !loading) {
      setSelectedCaseId("");
      setShowNetwork(false);
    }
  }, [loading, selectedCaseId, selectedRecord]);

  const selectFir = (record: FirRecord) => {
    setSelectedCaseId(record.id);
    setShowNetwork(false);
    void recordAuditEvent({
      action: "RECORD_ACCESS",
      targetType: "FIR",
      targetId: record.fir || record.label || record.id,
      result: "SUCCESS",
      details: { source: "Advanced Search" },
    });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document.getElementById("selected-fir-details")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    });
  };

  const run = () => {
    if (!q && !station && !status) return;

    void recordAuditEvent({
      action: "SEARCH",
      targetType: "FIR_RECORDS",
      targetId: "Advanced Search",
      result: "SUCCESS",
      details: {
        query: q,
        station: station || "All stations",
        status: status || "All statuses",
        matchingCases: results.length,
      },
    });

    const searchLabel = q || `${station} ${status}`.trim();
    const n = [searchLabel, ...recent.filter((x) => x !== searchLabel)].slice(0, 5);

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
            "Search across FIR number, accused, complainant, section, station and investigating officer.",
            "ಎಫ್‌ಐಆರ್ ಸಂಖ್ಯೆ, ಆರೋಪಿ, ದೂರುದಾರ, ಸೆಕ್ಷನ್, ಠಾಣೆ ಮತ್ತು ತನಿಖಾಧಿಕಾರಿ ಮೂಲಕ ಹುಡುಕಿ."
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
              "Crime no, accused, complainant, section...",
              "ಪ್ರಕರಣ ಸಂಖ್ಯೆ, ಆರೋಪಿ, ದೂರುದಾರ, ಸೆಕ್ಷನ್..."
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
            className="h-10 px-4 bg-brand rounded-lg text-sm font-semibold text-white"
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
          {loading && <div className="py-12 text-center text-sm text-muted" role="status">{t("Searching FIR records…", "ಎಫ್‌ಐಆರ್ ದಾಖಲೆಗಳನ್ನು ಹುಡುಕಲಾಗುತ್ತಿದೆ…")}</div>}
          {error && (
            <div className="rounded-lg border border-rose/30 bg-rose/10 p-4 text-sm text-rose" role="alert">
              <p>{navigator.onLine ? error : t("You are offline. Reconnect and try again.", "ನೀವು ಆಫ್‌ಲೈನ್‌ನಲ್ಲಿದ್ದೀರಿ. ಮರುಸಂಪರ್ಕಿಸಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.")}</p>
              <button type="button" onClick={() => void reload()} className="mt-3 rounded-lg border border-rose/40 px-3 py-2 text-xs font-semibold">{t("Try again", "ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ")}</button>
            </div>
          )}
          {!loading && !error && showNetwork && criminalNetwork && (
            <CriminalNetworkGraph
              network={criminalNetwork}
              onBack={() => setShowNetwork(false)}
              t={t}
            />
          )}
          {!loading && !error && !showNetwork && <div className="space-y-2">
            {selectedRecord && criminalNetwork && (
              <section id="selected-fir-details" className="mb-4 scroll-mt-4 rounded-xl border border-brand/35 bg-panel p-4 shadow-glow" aria-labelledby="selected-fir-title">
                <div className="flex flex-col gap-3 border-b border-line pb-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                      {t("FIR details from database", "ಡೇಟಾಬೇಸ್‌ನಿಂದ ಎಫ್‌ಐಆರ್ ವಿವರಗಳು")}
                    </span>
                    <h2 id="selected-fir-title" className="mt-1 text-lg font-semibold text-brand">
                      {selectedRecord.label}
                    </h2>
                    <p className="mt-1 text-xs text-muted">
                      {displayKnownValue(selectedRecord.category, language)} · {displayKnownValue(selectedRecord.status, language)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedCaseId("")}
                    className="min-h-9 self-start rounded-lg border border-line px-3 text-xs font-semibold hover:border-brand"
                  >
                    {t("Close details", "ವಿವರಗಳನ್ನು ಮುಚ್ಚಿ")}
                  </button>
                </div>

                <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <dt className="text-muted">{t("Crime number", "ಅಪರಾಧ ಸಂಖ್ಯೆ")}</dt>
                    <dd className="mt-1 font-semibold">{selectedRecord.fir || t("Not recorded", "ದಾಖಲಾಗಿಲ್ಲ")}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t("Police station", "ಪೊಲೀಸ್ ಠಾಣೆ")}</dt>
                    <dd className="mt-1 font-semibold">{selectedRecord.station ? displayPlaceName(selectedRecord.station, language) : t("Not recorded", "ದಾಖಲಾಗಿಲ್ಲ")}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t("Registered date", "ದಾಖಲಿಸಿದ ದಿನಾಂಕ")}</dt>
                    <dd className="mt-1 font-semibold">{selectedRecord.date || t("Not recorded", "ದಾಖಲಾಗಿಲ್ಲ")}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t("Accused names", "ಆರೋಪಿಗಳ ಹೆಸರುಗಳು")}</dt>
                    <dd className="mt-1 font-semibold">{selectedRecord.raw.AccusedNames || t("Not recorded", "ದಾಖಲಾಗಿಲ್ಲ")}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t("Investigating officer", "ತನಿಖಾಧಿಕಾರಿ")}</dt>
                    <dd className="mt-1 font-semibold">{selectedRecord.io || t("Not recorded", "ದಾಖಲಾಗಿಲ್ಲ")}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t("Acts and sections", "ಕಾಯ್ದೆಗಳು ಮತ್ತು ಸೆಕ್ಷನ್‌ಗಳು")}</dt>
                    <dd className="mt-1 font-semibold">{selectedRecord.section || t("Not recorded", "ದಾಖಲಾಗಿಲ್ಲ")}</dd>
                  </div>
                </dl>

                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => setShowNetwork(true)}
                    className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white shadow-glow"
                  >
                    {t("Criminal Network Graph", "ಅಪರಾಧ ಜಾಲ ನಕ್ಷೆ")}
                    <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px]">
                      {criminalNetwork.relatedCases.length} {t("linked FIRs", "ಸಂಬಂಧಿತ ಎಫ್‌ಐಆರ್‌ಗಳು")}
                    </span>
                  </button>
                </div>
              </section>
            )}

            {pageResults.map((r) => (
              <button
                type="button"
                onClick={() => selectFir(r)}
                key={r.id}
                aria-pressed={selectedCaseId === r.id}
                className={`w-full p-3 rounded-lg border text-left flex justify-between ${selectedCaseId === r.id ? "border-brand bg-brand/5" : "border-line hover:border-brand/40"}`}
              >
                <div>
                  <div className="text-sm font-semibold text-brand">
                    {r.label}
                  </div>

                  <div className="text-xs text-muted mt-1">
                    {displayKnownValue(r.category, language)} · {r.complainant} ·{" "}
                    {displayPlaceName(r.station, language)}
                  </div>
                </div>

                <div className="ml-3 shrink-0 text-right text-xs text-muted">
                  <div>{displayKnownValue(r.status, language)}</div>
                  <div className="mt-2 font-semibold text-brand">{t("View details", "ವಿವರಗಳನ್ನು ನೋಡಿ")} →</div>
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
            {results.length > pageSize && (
              <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
                <span>{t("Showing", "ತೋರಿಸಲಾಗುತ್ತಿದೆ")} {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, results.length)} {t("of", "ರಲ್ಲಿ")} {results.length}</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1} className="rounded-lg border border-line px-3 py-2 disabled:opacity-40">{t("Previous", "ಹಿಂದಿನದು")}</button>
                  <span className="grid min-w-16 place-items-center">{page} / {pageCount}</span>
                  <button type="button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page === pageCount} className="rounded-lg border border-line px-3 py-2 disabled:opacity-40">{t("Next", "ಮುಂದಿನದು")}</button>
                </div>
              </div>
            )}
          </div>}
        </Card>
      </div>
    </div>
  );
};

/* =========================================================
   REPORTS
========================================================= */

export const Reports: React.FC = () => {
  const { language, tr: t } = useLanguage();
  const { records, loading, error } = useFirRecords();
  const [activeView, setActiveView] = useState<"reports" | "audit">("reports");
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
    start.setDate(start.getDate() - 180);
    let end = new Date();

    if (fromDate) start = new Date(fromDate);
    if (toDate) end = new Date(toDate);

    const buckets = new Map<string, { m: string; fir: number; closed: number }>();

    let d = new Date(start);
    d.setDate(1);
    while (d <= end) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString(language === "kn" ? "kn-IN" : "en-IN", { month: "short", year: "numeric" });
      buckets.set(key, { m: label, fir: 0, closed: 0 });
      d.setMonth(d.getMonth() + 1);
    }

    for (const record of filteredRecords) {
      const date = new Date(record.date);
      if (!Number.isFinite(date.getTime())) continue;
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      if (!buckets.has(key)) continue;

      const bucket = buckets.get(key)!;
      bucket.fir += 1;
      if (closedStatuses.includes(record.status)) {
        bucket.closed += 1;
      }
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value);
  }, [filteredRecords, fromDate, toDate, language]);

  const station = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const record of filteredRecords) {
      const key = record.station || "Unassigned";
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    return Array.from(buckets.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, value]) => ({ n: displayPlaceName(name.replace(" Police Station", ""), language), v: value }));
  }, [filteredRecords, language]);

  const pie = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const record of filteredRecords) {
      const key = record.raw.CrimeHead || record.category || "Other";
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    return Array.from(buckets.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, value]) => ({ name: displayKnownValue(name, language), value }));
  }, [filteredRecords, language]);

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
    displayKnownValue(item.name, language),
    item.count.toLocaleString(language === "kn" ? "kn-IN" : "en-IN"),
    totalCases ? `${Math.round((item.count / totalCases) * 1000) / 10}%` : "0%",
  ]);
  const stationRows = station.map((item) => [
    item.n,
    item.v.toLocaleString(language === "kn" ? "kn-IN" : "en-IN"),
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
    void recordAuditEvent({
      action: "REPORT_EXPORT",
      targetType: "REPORT",
      targetId: "FIR report CSV",
      result: "SUCCESS",
      details: { format: "CSV", records: filteredRecords.length, fromDate, toDate },
    });
  };

  const printReport = () => {
    void recordAuditEvent({
      action: "REPORT_PRINT",
      targetType: "REPORT",
      targetId: "Reports and Analytics",
      result: "SUCCESS",
      details: { format: "Print or PDF", records: filteredRecords.length, fromDate, toDate },
    });
    window.print();
  };

  return (
    <div className="p-5 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">
            {t(
              "Reports & Analytics",
              "ವರದಿಗಳು ಮತ್ತು ವಿಶ್ಲೇಷಣೆ"
            )}
          </h1>

          <p className="text-sm text-muted mt-1">
            {activeView === "reports"
              ? t(
                "Operational trends, workload and disposal performance.",
                "ಕಾರ್ಯಾಚರಣಾ ಪ್ರವೃತ್ತಿ, ಕೆಲಸದ ಹೊರೆ ಮತ್ತು ವಿಲೇವಾರಿ ಕಾರ್ಯಕ್ಷಮತೆ."
              )
              : t(
                "Who did what, when, where and whether it succeeded.",
                "ಯಾರು ಏನು, ಯಾವಾಗ, ಎಲ್ಲಿ ಮಾಡಿದರು ಮತ್ತು ಅದು ಯಶಸ್ವಿಯಾಗಿದೆಯೇ."
              )}
          </p>
        </div>

        {activeView === "reports" && <div className="flex flex-wrap gap-2">
          <button
            onClick={printReport}
            className="h-9 px-3 border border-line rounded-lg text-xs"
          >
            {t(
              "Print / Save PDF",
              "ಪಿಡಿಎಫ್ ರಚಿಸಿ"
            )}
          </button>

          <button
            onClick={csv}
            className="h-9 px-3 bg-brand rounded-lg text-xs text-white font-semibold"
          >
            {t(
              "Export CSV",
              "ಸಿಎಸ್ವಿ ರಫ್ತು"
            )}
          </button>
        </div>}
      </div>

      <div className="inline-flex w-full rounded-xl border border-line bg-shell p-1 sm:w-auto" role="tablist" aria-label={t("Reports sections", "ವರದಿ ವಿಭಾಗಗಳು")}>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "reports"}
          onClick={() => setActiveView("reports")}
          className={`min-h-10 flex-1 rounded-lg px-4 text-sm font-semibold transition sm:flex-none ${activeView === "reports" ? "bg-brand text-white shadow-soft" : "text-muted hover:text-brand"}`}
        >
          {t("Reports & Analytics", "ವರದಿಗಳು ಮತ್ತು ವಿಶ್ಲೇಷಣೆ")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "audit"}
          onClick={() => setActiveView("audit")}
          className={`min-h-10 flex-1 rounded-lg px-4 text-sm font-semibold transition sm:flex-none ${activeView === "audit" ? "bg-brand text-white shadow-soft" : "text-muted hover:text-brand"}`}
        >
          {t("Audit Trail", "ಲೆಕ್ಕಪರಿಶೋಧನಾ ದಾಖಲೆ")}
        </button>
      </div>

      {activeView === "audit" ? <AuditTrailPanel /> : <>
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
              loading ? "..." : t(`${avgInvestigationDays} days`, `${avgInvestigationDays} ದಿನಗಳು`),
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
                  label={{ value: t("Month / Year", "ತಿಂಗಳು / ವರ್ಷ"), position: "insideBottomRight", offset: -5, fontSize: 10, fill: "var(--muted)" }}
                />

                <YAxis
                  fontSize={11}
                  stroke="currentColor"
                  opacity={0.65}
                  label={{ value: t("Number of FIRs", "ಎಫ್‌ಐಆರ್‌ಗಳ ಸಂಖ್ಯೆ"), angle: -90, position: "insideLeft", fontSize: 10, fill: "var(--muted)" }}
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
                  label={{ value: t("Station", "ಠಾಣೆ"), position: "insideBottomRight", offset: -5, fontSize: 10, fill: "var(--muted)" }}
                />

                <YAxis
                  fontSize={11}
                  stroke="currentColor"
                  opacity={0.65}
                  label={{ value: t("Workload (FIRs)", "ಕೆಲಸದ ಹೊರೆ (ಎಫ್‌ಐಆರ್‌ಗಳು)"), angle: -90, position: "insideLeft", fontSize: 10, fill: "var(--muted)" }}
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
            columns={[t("Status", "ಸ್ಥಿತಿ"), t("Cases", "ಪ್ರಕರಣಗಳು"), t("Share", "ಪಾಲು")]}
            rows={statusRows}
            emptyText={t("No status data available.", "ಸ್ಥಿತಿ ದತ್ತಾಂಶ ಲಭ್ಯವಿಲ್ಲ.")}
          />
          <ReferenceTable
            columns={[t("Top Station", "ಪ್ರಮುಖ ಠಾಣೆ"), t("Cases", "ಪ್ರಕರಣಗಳು"), t("Share", "ಪಾಲು")]}
            rows={stationRows}
            emptyText={t("No station workload data available.", "ಠಾಣೆಯ ಕೆಲಸದ ಹೊರೆ ದತ್ತಾಂಶ ಲಭ್ಯವಿಲ್ಲ.")}
          />
        </div>
      </>}
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
  const t = useT();
  const { records, loading, error } = useFirRecords();
  const groups = groupByKey(records, (record) => record.raw.EmployeeID || record.io);
  const rows = groups.map(([key, employeeCases]) => {
    const sample = employeeCases[0];
    const active = employeeCases.filter((record) => record.status === "Under Investigation").length;
    return [
      <div>
        <div className="font-semibold text-brand">{sample.raw.EmployeeID || key}</div>
        <div className="text-xs text-muted mt-1">{sample.io || t("Officer name not captured", "ಅಧಿಕಾರಿಯ ಹೆಸರು ದಾಖಲಾಗಿಲ್ಲ")}</div>
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
        title={t("Employees", "ಸಿಬ್ಬಂದಿ")}
        description={t("Officer directory built from EmployeeID, officer name, rank, designation, and assigned cases.", "ಉದ್ಯೋಗಿ ಐಡಿ, ಅಧಿಕಾರಿಯ ಹೆಸರು, ಹುದ್ದೆ, ಪದನಾಮ ಮತ್ತು ನಿಯೋಜಿತ ಪ್ರಕರಣಗಳಿಂದ ರಚಿಸಿದ ಅಧಿಕಾರಿಗಳ ಡೈರೆಕ್ಟರಿ.")}
        loading={loading}
        error={error}
        count={records.length}
      />
      <div className="grid md:grid-cols-3 gap-3">
        <ReferenceStat label={t("Employees", "ಸಿಬ್ಬಂದಿ")} value={groups.length} helper={t("Unique employee IDs/officers", "ವಿಶಿಷ್ಟ ಉದ್ಯೋಗಿ ಐಡಿಗಳು/ಅಧಿಕಾರಿಗಳು")} />
        <ReferenceStat label={t("Ranks", "ಹುದ್ದೆಗಳು")} value={countByValue(records, "OfficerRank").length} />
        <ReferenceStat label={t("Designations", "ಪದನಾಮಗಳು")} value={countByValue(records, "OfficerDesignation").length} />
      </div>
      <ReferenceTable
        columns={[t("Employee", "ಸಿಬ್ಬಂದಿ"), t("Rank", "ಹುದ್ದೆ"), t("Designation", "ಪದನಾಮ"), t("Stations", "ಠಾಣೆಗಳು"), t("Cases", "ಪ್ರಕರಣಗಳು"), t("Active", "ಸಕ್ರಿಯ")]}
        rows={rows}
      />
    </div>
  );
};

export const MasterData: React.FC = () => {
  const t = useT();
  const { records, loading, error } = useFirRecords();
  const dataGroups = [
    [t("Crime Heads", "ಅಪರಾಧ ಶೀರ್ಷಿಕೆಗಳು"), countByValue(records, "CrimeHead")],
    [t("Crime Sub Heads", "ಅಪರಾಧ ಉಪಶೀರ್ಷಿಕೆಗಳು"), countByValue(records, "CrimeSubHead")],
    [t("Acts", "ಕಾಯ್ದೆಗಳು"), countByValue(records, "Acts", true)],
    [t("Sections", "ಸೆಕ್ಷನ್‌ಗಳು"), countByValue(records, "Sections", true)],
    [t("Statuses", "ಸ್ಥಿತಿಗಳು"), countByValue(records, "Status")],
    [t("Case Categories", "ಪ್ರಕರಣ ವರ್ಗಗಳು"), countByValue(records, "CaseCategory")],
    [t("Gravity", "ಗಂಭೀರತೆ"), countByValue(records, "Gravity")],
    [t("Chargesheet Status", "ಆರೋಪಪಟ್ಟಿ ಸ್ಥಿತಿ"), countByValue(records, "ChargesheetStatus")],
  ] as const;

  const totalValues = dataGroups.reduce((sum, [, values]) => sum + values.length, 0);

  return (
    <div className="p-5 space-y-4">
      <ReferenceHeader
        title={t("Master Data", "ಮಾಸ್ಟರ್ ಡೇಟಾ")}
        description={t("Crime, legal, status, category, and chargesheet reference values currently used by FIR records.", "ಎಫ್‌ಐಆರ್ ದಾಖಲೆಗಳು ಪ್ರಸ್ತುತ ಬಳಸುವ ಅಪರಾಧ, ಕಾನೂನು, ಸ್ಥಿತಿ, ವರ್ಗ ಮತ್ತು ಆರೋಪಪಟ್ಟಿ ಉಲ್ಲೇಖ ಮೌಲ್ಯಗಳು.")}
        loading={loading}
        error={error}
        count={records.length}
      />
      <div className="grid md:grid-cols-4 gap-3">
        <ReferenceStat label={t("Reference Values", "ಉಲ್ಲೇಖ ಮೌಲ್ಯಗಳು")} value={totalValues} />
        <ReferenceStat label={t("Crime Heads", "ಅಪರಾಧ ಶೀರ್ಷಿಕೆಗಳು")} value={dataGroups[0][1].length} />
        <ReferenceStat label={t("Acts", "ಕಾಯ್ದೆಗಳು")} value={dataGroups[2][1].length} />
        <ReferenceStat label={t("Sections", "ಸೆಕ್ಷನ್‌ಗಳು")} value={dataGroups[3][1].length} />
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
  const { language, tr: t } = useLanguage();
  const { records, loading, error } = useFirRecords();
  const [query, setQuery] = useState("");
  const [district, setDistrict] = useState("all");
  const [sort, setSort] = useState<"cases" | "active" | "name">("cases");
  const groups = useMemo(() => groupByKey(records, (record) => record.station), [records]);
  const stations = useMemo(() => groups.map(([name, stationCases]) => {
    const active = stationCases.filter((record) => record.status === "Under Investigation").length;
    return {
      name,
      displayName: displayPlaceName(name, language),
      type: uniqueText(stationCases.map((record) => record.raw.PoliceStationType)),
      district: uniqueText(stationCases.map((record) => record.raw.District)),
      courts: uniqueTextValues(stationCases.map((record) => record.raw.Court)),
      cases: stationCases.length,
      active,
      activeShare: stationCases.length ? Math.round((active / stationCases.length) * 100) : 0,
    };
  }), [groups, language]);
  const districtOptions = useMemo(() => uniqueTextValues(stations.map((item) => item.district)), [stations]);
  const visibleStations = useMemo(() => stations
    .filter((item) => district === "all" || item.district === district)
    .filter((item) => `${item.name} ${item.district} ${item.type} ${item.courts.join(" ")}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => sort === "name" ? a.displayName.localeCompare(b.displayName) : b[sort] - a[sort]),
    [stations, district, query, sort]);
  const topStations = useMemo(() => [...stations].sort((a, b) => b.cases - a.cases).slice(0, 8), [stations]);
  const districtData = useMemo(() => countByValue(records, "District").slice(0, 6), [records]);
  const activeTotal = stations.reduce((sum, station) => sum + station.active, 0);
  const busiest = topStations[0];
  const palette = ["#174a7e", "#2f78b7", "#58a6c9", "#7ab8a8", "#d4a72c", "#b5673f"];
  const summaryCards: Array<{ Icon: React.ElementType; label: string; value: number; helper: string }> = [
    { Icon: Building2, label: t("Stations", "ಠಾಣೆಗಳು"), value: groups.length, helper: t("operational units", "ಕಾರ್ಯಾಚರಣಾ ಘಟಕಗಳು") },
    { Icon: MapPin, label: t("Districts", "ಜಿಲ್ಲೆಗಳು"), value: districtOptions.length, helper: t("areas covered", "ವ್ಯಾಪ್ತಿಯ ಪ್ರದೇಶಗಳು") },
    { Icon: Activity, label: t("Active cases", "ಸಕ್ರಿಯ ಪ್ರಕರಣಗಳು"), value: activeTotal, helper: `${records.length ? Math.round((activeTotal / records.length) * 100) : 0}% ${t("of all cases", "ಎಲ್ಲಾ ಪ್ರಕರಣಗಳಲ್ಲಿ")}` },
    { Icon: Scale, label: t("Highest workload", "ಅತಿ ಹೆಚ್ಚು ಕೆಲಸದ ಹೊರೆ"), value: busiest?.cases || 0, helper: busiest?.displayName || "-" },
  ];

  return (
    <div className="space-y-5 p-3 sm:p-5">
      <ReferenceHeader
        title={t("Units & Stations", "ಘಟಕಗಳು ಮತ್ತು ಠಾಣೆಗಳು")}
        description={t("See workload, active-case pressure, district coverage and court links at a glance.", "ಕೆಲಸದ ಹೊರೆ, ಸಕ್ರಿಯ ಪ್ರಕರಣದ ಒತ್ತಡ, ಜಿಲ್ಲಾ ವ್ಯಾಪ್ತಿ ಮತ್ತು ನ್ಯಾಯಾಲಯದ ಸಂಪರ್ಕಗಳನ್ನು ಒಂದೇ ನೋಟದಲ್ಲಿ ನೋಡಿ.")}
        loading={loading}
        error={error}
        count={records.length}
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {summaryCards.map(({ Icon, label, value, helper }) => (
          <Card key={String(label)} className="relative overflow-hidden p-4">
            <div className="absolute -right-4 -top-4 h-20 w-20 rounded-full bg-brand/5" />
            <div className="flex items-center gap-2 text-xs text-muted"><Icon size={15} className="text-brand" />{label}</div>
            <div className="num mt-2 text-2xl font-semibold">{Number(value).toLocaleString("en-IN")}</div>
            <div className="mt-1 truncate text-[11px] text-muted">{helper}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        <Card className="p-4 sm:p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div><h2 className="font-semibold">{t("Workload by station", "ಠಾಣೆವಾರು ಕೆಲಸದ ಹೊರೆ")}</h2><p className="mt-1 text-xs text-muted">{t("Top 8 stations · active cases highlighted", "ಅಗ್ರ 8 ಠಾಣೆಗಳು · ಸಕ್ರಿಯ ಪ್ರಕರಣಗಳನ್ನು ಹೈಲೈಟ್ ಮಾಡಲಾಗಿದೆ")}</p></div>
            <span className="rounded-full bg-brand/10 px-2.5 py-1 text-[10px] font-semibold text-brand">{t("CASES", "ಪ್ರಕರಣಗಳು")}</span>
          </div>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topStations} layout="vertical" margin={{ top: 0, right: 18, left: 4, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" horizontal={false} strokeDasharray="3 3" />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="displayName" width={118} tick={{ fontSize: 10, fill: "var(--muted)" }} axisLine={false} tickLine={false} tickFormatter={(value) => String(value).replace(/ Police Station| PS/gi, "").slice(0, 17)} />
                <Tooltip cursor={{ fill: "rgba(23,74,126,.06)" }} contentStyle={{ background: "var(--shell)", border: "1px solid var(--line)", borderRadius: 10, fontSize: 12 }} />
                <Bar dataKey="cases" name={t("Total cases", "ಒಟ್ಟು ಪ್ರಕರಣಗಳು")} fill="#9bb4cb" radius={[0, 5, 5, 0]} barSize={15} />
                <Bar dataKey="active" name={t("Active", "ಸಕ್ರಿಯ")} fill="#174a7e" radius={[0, 5, 5, 0]} barSize={15} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card className="p-4 sm:p-5">
          <h2 className="font-semibold">{t("District coverage", "ಜಿಲ್ಲಾ ವ್ಯಾಪ್ತಿ")}</h2>
          <p className="mt-1 text-xs text-muted">{t("Share of FIR records by district", "ಜಿಲ್ಲೆವಾರು ಎಫ್‌ಐಆರ್ ದಾಖಲೆಗಳ ಪಾಲು")}</p>
          <div className="relative mt-2 h-[190px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart><Pie data={districtData} dataKey="count" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={2}>{districtData.map((item, index) => <Cell key={item.name} fill={palette[index % palette.length]} />)}</Pie><Tooltip contentStyle={{ background: "var(--shell)", border: "1px solid var(--line)", borderRadius: 10, fontSize: 12 }} /></PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 grid place-content-center text-center"><strong className="num text-xl">{records.length.toLocaleString("en-IN")}</strong><span className="text-[10px] text-muted">{t("records", "ದಾಖಲೆಗಳು")}</span></div>
          </div>
          <div className="space-y-2">{districtData.slice(0, 5).map((item, index) => <div key={item.name} className="flex items-center gap-2 text-xs"><i className="h-2 w-2 rounded-full" style={{ background: palette[index % palette.length] }} /><span className="min-w-0 flex-1 truncate">{displayPlaceName(item.name, language)}</span><b className="num">{item.count}</b></div>)}</div>
        </Card>
      </div>

      <Card className="p-3 sm:p-4">
        <div className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_180px_160px]">
          <label className="flex h-10 items-center gap-2 rounded-lg border border-line bg-panel px-3"><Search size={15} className="text-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search station, court or type…", "ಠಾಣೆ, ನ್ಯಾಯಾಲಯ ಅಥವಾ ಪ್ರಕಾರ ಹುಡುಕಿ…")} className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
          <select aria-label={t("Filter by district", "ಜಿಲ್ಲೆಯ ಪ್ರಕಾರ ಫಿಲ್ಟರ್ ಮಾಡಿ")} value={district} onChange={(event) => setDistrict(event.target.value)} className="h-10 rounded-lg border border-line bg-panel px-3 text-sm"><option value="all">{t("All districts", "ಎಲ್ಲಾ ಜಿಲ್ಲೆಗಳು")}</option>{districtOptions.map((item) => <option key={item}>{item}</option>)}</select>
          <select aria-label={t("Sort stations", "ಠಾಣೆಗಳನ್ನು ವಿಂಗಡಿಸಿ")} value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="h-10 rounded-lg border border-line bg-panel px-3 text-sm"><option value="cases">{t("Most cases", "ಹೆಚ್ಚು ಪ್ರಕರಣಗಳು")}</option><option value="active">{t("Most active", "ಹೆಚ್ಚು ಸಕ್ರಿಯ")}</option><option value="name">{t("Name A–Z", "ಹೆಸರು A–Z")}</option></select>
        </div>
      </Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visibleStations.map((station) => <Card key={station.name} className="p-4 transition hover:-translate-y-0.5 hover:border-brand/35 hover:shadow-lg">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate font-semibold text-brand">{station.displayName}</h3><p className="mt-1 flex items-center gap-1 text-[11px] text-muted"><MapPin size={11} />{displayPlaceName(station.district, language)} · {station.type}</p></div><span className="num rounded-lg bg-brand/10 px-2.5 py-1 text-sm font-bold text-brand">{station.cases}</span></div>
          <div className="mt-4"><div className="flex justify-between text-[11px]"><span className="text-muted">{t("Active workload", "ಸಕ್ರಿಯ ಕೆಲಸದ ಹೊರೆ")}</span><b>{station.active} · {station.activeShare}%</b></div><div className="mt-1.5 h-2 overflow-hidden rounded-full bg-panel"><div className="h-full rounded-full bg-brand" style={{ width: `${station.activeShare}%` }} /></div></div>
          <div className="mt-4 border-t border-line pt-3"><div className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted"><Scale size={12} />{t("Linked courts", "ಸಂಪರ್ಕಿತ ನ್ಯಾಯಾಲಯಗಳು")}</div><div className="flex flex-wrap gap-1.5">{station.courts.slice(0, 2).map((court) => <span key={court} title={court} className="max-w-full truncate rounded-full border border-line bg-panel px-2 py-1 text-[10px]">{court}</span>)}{station.courts.length > 2 && <span className="rounded-full bg-brand/10 px-2 py-1 text-[10px] text-brand">+{station.courts.length - 2}</span>}</div></div>
        </Card>)}
      </div>
      {!loading && visibleStations.length === 0 && <Card className="p-10 text-center text-sm text-muted">{t("No stations match these filters.", "ಈ ಫಿಲ್ಟರ್‌ಗಳಿಗೆ ಯಾವುದೇ ಠಾಣೆಗಳು ಹೊಂದಿಕೆಯಾಗುವುದಿಲ್ಲ.")}</Card>}
    </div>
  );
};

export const Courts: React.FC = () => {
  const t = useT();
  const { records, loading, error } = useFirRecords();
  const [query, setQuery] = useState("");
  const [metric, setMetric] = useState<"cases" | "filed" | "pendingTrial">("cases");
  const groups = useMemo(() => groupByKey(records, (record) => record.raw.Court), [records]);
  const courtRows = useMemo(() => groups.map(([court, courtCases]) => {
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
  }), [groups]);
  const filedTotal = courtRows.reduce((sum, row) => sum + row.filed, 0);
  const pendingTotal = courtRows.reduce((sum, row) => sum + row.pendingTrial, 0);
  const locale = document.documentElement.lang === "kn" ? "kn-IN" : "en-IN";
  const visibleCourts = useMemo(() => courtRows
    .filter((row) => `${row.court} ${row.districts.join(" ")} ${row.stations.join(" ")}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b[metric] - a[metric]), [courtRows, query, metric]);
  const topCourts = visibleCourts.slice(0, 8).map((row) => ({ ...row, shortName: row.court.replace(/Court of |Bengaluru/gi, "").slice(0, 22) }));
  const busiestCourt = [...courtRows].sort((a, b) => b.cases - a.cases)[0];

  return (
    <div className="space-y-4 p-3 sm:p-5">
      <ReferenceHeader
        title={t("Courts", "ನ್ಯಾಯಾಲಯಗಳು")}
        description={t("Understand court workload, case progress and connected police stations without scanning a directory.", "ಡೈರೆಕ್ಟರಿಯನ್ನು ಪರಿಶೀಲಿಸದೆ ನ್ಯಾಯಾಲಯದ ಕೆಲಸದ ಹೊರೆ, ಪ್ರಕರಣದ ಪ್ರಗತಿ ಮತ್ತು ಸಂಪರ್ಕಿತ ಪೊಲೀಸ್ ಠಾಣೆಗಳನ್ನು ಅರ್ಥಮಾಡಿಕೊಳ್ಳಿ.")}
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

      <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        <Card className="p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">{t("Court workload comparison", "ನ್ಯಾಯಾಲಯದ ಕೆಲಸದ ಹೊರೆ ಹೋಲಿಕೆ")}</h2><p className="mt-1 text-xs text-muted">{t("Top courts ranked by your selected measure", "ನೀವು ಆಯ್ಕೆ ಮಾಡಿದ ಅಳತೆಯ ಪ್ರಕಾರ ಅಗ್ರ ನ್ಯಾಯಾಲಯಗಳು")}</p></div><div className="flex rounded-lg border border-line bg-panel p-1">{(["cases", "filed", "pendingTrial"] as const).map((item) => <button type="button" aria-pressed={metric === item} key={item} onClick={() => setMetric(item)} className={`rounded-md px-2.5 py-1.5 text-[10px] font-semibold transition ${metric === item ? "bg-brand text-white shadow" : "text-muted"}`}>{item === "cases" ? t("CASES", "ಪ್ರಕರಣಗಳು") : item === "filed" ? t("FILED", "ಸಲ್ಲಿಸಲಾಗಿದೆ") : t("PENDING", "ಬಾಕಿ")}</button>)}</div></div>
          <div className="h-[300px]"><ResponsiveContainer width="100%" height="100%"><BarChart data={topCourts} layout="vertical" margin={{ top: 0, right: 22, left: 8, bottom: 0 }}><CartesianGrid stroke="var(--line)" horizontal={false} strokeDasharray="3 3" /><XAxis type="number" hide /><YAxis type="category" dataKey="shortName" width={130} tick={{ fontSize: 10, fill: "var(--muted)" }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: "var(--shell)", border: "1px solid var(--line)", borderRadius: 10, fontSize: 12 }} /><Bar dataKey={metric} fill={metric === "pendingTrial" ? "#d4a72c" : metric === "filed" ? "#4f9b78" : "#174a7e"} radius={[0, 6, 6, 0]} barSize={18} /></BarChart></ResponsiveContainer></div>
        </Card>
        <Card className="relative overflow-hidden p-5">
          <div className="absolute -right-14 -top-14 h-44 w-44 rounded-full border-[26px] border-brand/5" />
          <div className="relative"><span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand"><Gavel size={15} />{t("Workload leader", "ಕೆಲಸದ ಹೊರೆ ಮುಂಚೂಣಿ")}</span><h2 className="mt-4 text-lg font-semibold leading-7">{busiestCourt?.court || "-"}</h2><p className="mt-1 text-xs text-muted">{busiestCourt?.districts.join(", ") || "-"}</p>
            <div className="mt-6 grid grid-cols-3 divide-x divide-line rounded-xl border border-line bg-panel/50 py-3 text-center">{[[t("Cases", "ಪ್ರಕರಣಗಳು"), busiestCourt?.cases || 0], [t("Stations", "ಠಾಣೆಗಳು"), busiestCourt?.stations.length || 0], [t("Pending", "ಬಾಕಿ"), busiestCourt?.pendingTrial || 0]].map(([label, value]) => <div key={String(label)}><strong className="num block text-xl">{Number(value).toLocaleString(locale)}</strong><span className="text-[10px] text-muted">{label}</span></div>)}</div>
            <div className="mt-5"><div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{t("Station → court flow", "ಠಾಣೆ → ನ್ಯಾಯಾಲಯ ಹರಿವು")}</div>{busiestCourt?.stations.slice(0, 4).map((station) => <div key={station} className="mt-2 flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate rounded-lg border border-line bg-panel px-2.5 py-2">{station}</span><ArrowRight size={13} className="shrink-0 text-brand" /><Scale size={14} className="shrink-0 text-brand" /></div>)}</div></div>
        </Card>
      </div>

      <Card className="p-3 sm:p-4"><div className="flex h-10 items-center gap-2 rounded-lg border border-line bg-panel px-3"><Search size={15} className="text-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search court, district or linked station…", "ನ್ಯಾಯಾಲಯ, ಜಿಲ್ಲೆ ಅಥವಾ ಸಂಪರ್ಕಿತ ಠಾಣೆ ಹುಡುಕಿ…")} className="min-w-0 flex-1 bg-transparent text-sm outline-none" /><span className="text-[11px] text-muted">{visibleCourts.length} {t("courts", "ನ್ಯಾಯಾಲಯಗಳು")}</span></div></Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{visibleCourts.map((row) => {
        const filedShare = row.cases ? Math.round((row.filed / row.cases) * 100) : 0;
        const pendingShare = row.cases ? Math.round((row.pendingTrial / row.cases) * 100) : 0;
        return <Card key={row.court} className="p-4 transition hover:-translate-y-0.5 hover:border-brand/35 hover:shadow-lg"><div className="flex items-start gap-3"><div className="grid h-9 w-9 shrink-0 place-content-center rounded-lg bg-brand/10 text-brand"><Gavel size={17} /></div><div className="min-w-0"><h3 className="font-semibold leading-5 text-brand">{row.court}</h3><p className="mt-1 text-[11px] text-muted">{row.districts.join(", ") || "-"}</p></div></div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">{[[t("Cases", "ಪ್ರಕರಣಗಳು"), row.cases], [t("Filed", "ಸಲ್ಲಿಸಲಾಗಿದೆ"), row.filed], [t("Pending", "ಬಾಕಿ"), row.pendingTrial]].map(([label, value]) => <div key={String(label)} className="rounded-lg bg-panel py-2"><b className="num block text-base">{Number(value).toLocaleString(locale)}</b><span className="text-[9px] text-muted">{label}</span></div>)}</div>
          <div className="mt-4"><div className="flex justify-between text-[10px] text-muted"><span>{t("Case progress", "ಪ್ರಕರಣದ ಪ್ರಗತಿ")}</span><span>{filedShare}% {t("filed", "ಸಲ್ಲಿಸಲಾಗಿದೆ")}</span></div><div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-panel"><i className="h-full bg-[#4f9b78]" style={{ width: `${filedShare}%` }} /><i className="h-full bg-[#d4a72c]" style={{ width: `${pendingShare}%` }} /></div></div>
          <div className="mt-4 border-t border-line pt-3"><div className="mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted"><span>{t("Connected stations", "ಸಂಪರ್ಕಿತ ಠಾಣೆಗಳು")}</span><span>{row.stations.length}</span></div><div className="flex flex-wrap gap-1.5">{row.stations.slice(0, 3).map((station) => <span key={station} title={station} className="max-w-full truncate rounded-full border border-line bg-panel px-2 py-1 text-[10px]">{station}</span>)}{row.stations.length > 3 && <span className="rounded-full bg-brand/10 px-2 py-1 text-[10px] text-brand">+{row.stations.length - 3}</span>}</div></div>
        </Card>;
      })}</div>
      {!loading && visibleCourts.length === 0 && <Card className="p-10 text-center text-sm text-muted">{t("No courts match this search.", "ಈ ಹುಡುಕಾಟಕ್ಕೆ ಯಾವುದೇ ನ್ಯಾಯಾಲಯಗಳು ಹೊಂದಿಕೆಯಾಗುವುದಿಲ್ಲ.")}</Card>}
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
  const { language } = useLanguage();

  const t = useT();
  const nav = useNavigate();

  const [station] = useState(
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
  const [pullConfirmOpen, setPullConfirmOpen] = useState(false);

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
          throw new Error(language === "kn" ? "ಉಳಿಸಿದ ಫೋನ್ ಸಂಖ್ಯೆಯನ್ನು ಲೋಡ್ ಮಾಡಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ." : (data?.error || "Unable to load the saved phone number."));
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
          setPhoneError(error instanceof Error ? error.message : t("Unable to load the saved phone number.", "ಉಳಿಸಿದ ಫೋನ್ ಸಂಖ್ಯೆಯನ್ನು ಲೋಡ್ ಮಾಡಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ."));
        }
      })
      .finally(() => {
        if (!cancelled) setPhoneRecordLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.employeeId, language, t]);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setInterval(
      () => setResendSeconds((seconds) => Math.max(0, seconds - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

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
    setPullConfirmOpen(false);
    setPullState({
      status: "pulling",
      message: t("Pulling latest cases from Google Master Sheet...", "Google ಮಾಸ್ಟರ್ ಶೀಟ್‌ನಿಂದ ಇತ್ತೀಚಿನ ಪ್ರಕರಣಗಳನ್ನು ಪಡೆಯಲಾಗುತ್ತಿದೆ..."),
    });

    try {
      const data = await pullCasesFromMaster();
      await reloadCases(true);
      const count = data.cases?.length || 0;
      setPullState({
        status: "success",
        message: data.writeResult?.pending
          ? t(`Pulled ${count} cases into a pending local copy. Refresh once so it can be promoted.`, `${count} ಪ್ರಕರಣಗಳನ್ನು ಬಾಕಿಯಿರುವ ಸ್ಥಳೀಯ ಪ್ರತಿಗೆ ಪಡೆಯಲಾಗಿದೆ. ಅನ್ವಯಿಸಲು ಒಮ್ಮೆ ರಿಫ್ರೆಶ್ ಮಾಡಿ.`)
          : t(`Pulled ${count} cases successfully.`, `${count} ಪ್ರಕರಣಗಳನ್ನು ಯಶಸ್ವಿಯಾಗಿ ಪಡೆಯಲಾಗಿದೆ.`),
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
        throw new Error(language === "kn" ? "ಅಧಿಸೂಚನೆ ಆದ್ಯತೆಗಳನ್ನು ಉಳಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ." : (data?.error || "Unable to save notification preferences."));
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
                            className="h-9 px-3 bg-brand text-white rounded-lg text-xs font-medium disabled:opacity-60 whitespace-nowrap"
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
                {t("Sync Sheet", "ಶೀಟ್ ಸಿಂಕ್ ಮಾಡಿ")}
              </h2>
              <p className="mt-1 text-xs text-muted">
                {t(
                  "Fetch the latest master-sheet records and refresh the portal data.",
                  "ಇತ್ತೀಚಿನ ಮಾಸ್ಟರ್-ಶೀಟ್ ದಾಖಲೆಗಳನ್ನು ಪಡೆದು ಪೋರ್ಟಲ್ ದತ್ತಾಂಶವನ್ನು ನವೀಕರಿಸಿ.",
                )}
              </p>
            </div>

            <button
              type="button"
              onClick={() => setPullConfirmOpen(true)}
              disabled={pullState.status === "pulling"}
              className="h-10 px-4 rounded-lg bg-brand text-white text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {pullState.status === "pulling"
                ? t("Syncing...", "ಸಿಂಕ್ ಆಗುತ್ತಿದೆ...")
                : t("Pull Latest", "ಇತ್ತೀಚಿನದನ್ನು ಪಡೆಯಿರಿ")}
            </button>
          </div>

          {pullConfirmOpen && pullState.status !== "pulling" && (
            <div className="mt-4 rounded-xl border border-amber/30 bg-amber/10 p-4" role="alertdialog" aria-labelledby="sync-confirm-title">
              <h3 id="sync-confirm-title" className="text-sm font-semibold text-white">{t("Confirm data sync", "ದತ್ತಾಂಶ ಸಿಂಕ್ ದೃಢೀಕರಿಸಿ")}</h3>
              <p className="mt-1 text-xs leading-5 text-muted">{t("This pulls the current Google Master Sheet into the portal. Any unsent New FIR browser drafts are not affected.", "ಇದು ಪ್ರಸ್ತುತ Google ಮಾಸ್ಟರ್ ಶೀಟ್ ಅನ್ನು ಪೋರ್ಟಲ್‌ಗೆ ಪಡೆಯುತ್ತದೆ. ಕಳುಹಿಸದ ಹೊಸ ಎಫ್‌ಐಆರ್ ಬ್ರೌಸರ್ ಕರಡುಗಳಿಗೆ ಪರಿಣಾಮ ಬೀರುವುದಿಲ್ಲ.")}</p>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => setPullConfirmOpen(false)} className="rounded-lg border border-line px-3 py-2 text-xs font-semibold text-muted">{t("Cancel", "ರದ್ದು")}</button>
                <button type="button" onClick={() => void pullFromMaster()} className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white">{t("Sync latest records", "ಇತ್ತೀಚಿನ ದಾಖಲೆಗಳನ್ನು ಸಿಂಕ್ ಮಾಡಿ")}</button>
              </div>
            </div>
          )}

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

