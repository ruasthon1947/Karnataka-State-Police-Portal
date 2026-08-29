import { readTable } from "./googleSheets.mjs";

const CACHE_TTL_MS = 15_000;
let cache = { headers: [], records: [], fetchedAt: 0 };

function masterSheetId() {
  const value = String(
    process.env.GOOGLE_MASTER_SHEET_ID || process.env.GOOGLE_SHEET_ID || "",
  ).trim();
  if (!value) throw new Error("GOOGLE_MASTER_SHEET_ID is not configured.");
  return value;
}

export async function readExplicitTabRecords(tabName) {
  const table = await readTable(masterSheetId(), tabName);
  return table.rows;
}

export async function readSheetCases({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache.records.length && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { headers: cache.headers, records: cache.records };
  }

  const table = await readTable(
    masterSheetId(),
    process.env.GOOGLE_CASES_TAB || "CaseMaster",
  );
  cache = {
    headers: table.headers,
    records: table.rows,
    fetchedAt: now,
  };
  return { headers: table.headers, records: table.rows };
}

export function queryCasesInMemory(records, headers, filterSpec = {}, limit = 200) {
  let rows = records;
  for (const [key, value] of Object.entries(filterSpec)) {
    if (!headers.includes(key) || value == null || value === "") continue;
    const needle = String(value).toLowerCase();
    rows = rows.filter((row) =>
      String(row[key] ?? "").toLowerCase().includes(needle),
    );
  }
  return rows.slice(0, limit);
}
