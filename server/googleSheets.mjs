import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

// Credentials are deliberately server-only.  The service-account e-mail alone
// cannot authenticate to Google; set CATALYST_SERVICE_ACCOUNT_JSON to the JSON
// key (or a path to it) for catalyst-sync@karnatakastatepolice.iam.gserviceaccount.com.
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const MASTER_SHEET_ID = String(
  process.env.GOOGLE_MASTER_SHEET_ID || process.env.GOOGLE_SHEET_ID || "",
).trim();
const CONSOLIDATED_SHEET_ID = String(
  process.env.GOOGLE_CONSOLIDATED_SHEET_ID || "",
).trim();

const b64url = (value) => Buffer.from(value).toString("base64url");
const quoteRange = (tab, range = "A:ZZ") => encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${range}`);

function resolveCredentialSource(configured) {
  const raw = configured.trim();
  if (raw.startsWith("{")) return raw;

  const candidates = [path.resolve(raw)];
  for (const fallback of ["service-account.json", "config/service-account.json", "local_db/service_account.json"]) {
    const resolved = path.resolve(fallback);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  }

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `Google Sheets credentials file not found. Set GOOGLE_SERVICE_ACCOUNT_JSON in .env to the JSON key or a valid file path. Checked: ${candidates.join(", ")}`,
    );
  }
  return fs.readFileSync(found, "utf8");
}

function credential() {
  let configured = process.env.CATALYST_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  
  if (!configured) {
    for (const fallback of ["service-account.json", "config/service-account.json", "local_db/service_account.json"]) {
      const resolved = path.resolve(fallback);
      if (fs.existsSync(resolved)) {
        configured = resolved;
        break;
      }
    }
  }

  if (!configured) {
    throw new Error("Google Sheets is not configured. Please add the service-account JSON key directly as GOOGLE_SERVICE_ACCOUNT_JSON to your .env file.");
  }

  const raw = resolveCredentialSource(configured);
  const account = JSON.parse(raw);
  // Allow the specific sheet-158 account they provided or the catalyst-sync one
  if (
    account.client_email !== "catalyst-sync@karnatakastatepolice.iam.gserviceaccount.com" &&
    account.client_email !== "sheet-158@karnatakastatepolice.iam.gserviceaccount.com"
  ) {
    console.warn("Warning: Using service account email:", account.client_email);
  }
  return account;
}

let tokenCache = { token: "", expiresAt: 0 };
async function token() {
  if (tokenCache.token && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const account = credential();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: account.client_email, scope: SCOPES, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${payload}`).end().sign(account.private_key, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${payload}.${signature}` }) });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Google authentication failed: ${data.error_description || data.error || response.statusText}`);
  tokenCache = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google Sheets request failed: ${data.error?.message || response.statusText}`);
  return data;
}

async function ensureTab(sheetId, tab) {
  if (!String(sheetId || "").trim()) {
    throw new Error("Google Sheets ID is not configured.");
  }
  const meta = await request(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`);
  const exists = meta.sheets?.some((s) => s.properties.title === tab);
  if (!exists) {
    console.log(`Creating tab ${tab} in spreadsheet ${sheetId}`);
    await request(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] })
    });
  }
}

export async function readTable(sheetId, tab) {
  if (!String(sheetId || "").trim()) {
    throw new Error("Google Sheets ID is not configured.");
  }
  try {
    const data = await request(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${quoteRange(tab)}`);
    const values = data.values || [];
    const headers = values[0] || [];
    return { headers, rows: values.slice(1).filter((row) => row.some((cell) => String(cell || "").trim())).map((row) => Object.fromEntries(headers.map((header, index) => [header, String(row[index] ?? "")]))) };
  } catch (err) {
    if (err.message.includes("Unable to parse range")) {
      await ensureTab(sheetId, tab);
      return { headers: [], rows: [] };
    }
    throw err;
  }
}

export async function writeTable(sheetId, tab, headers, rows) {
  await ensureTab(sheetId, tab);
  await request(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${quoteRange(tab)}:clear`, { method: "POST", body: "{}" });
  return request(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${quoteRange(tab, "A1")}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ majorDimension: "ROWS", values: [headers, ...rows.map((row) => headers.map((header) => String(row[header] ?? "")))] }) });
}

export async function appendRow(sheetId, tab, rowArray) {
  await ensureTab(sheetId, tab);
  return request(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${quoteRange(tab, "A1")}:append?valueInputOption=RAW`, { 
    method: "POST", 
    body: JSON.stringify({ majorDimension: "ROWS", values: [rowArray] }) 
  });
}

export async function updateRow(sheetId, tab, sheetRowIndex, rowArray) {
  const range = `${tab}!A${sheetRowIndex}`;
  return request(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ majorDimension: "ROWS", values: [rowArray] })
  });
}

function recordKey(row) { return String(row.CaseMasterID || row.CaseNo || row.CrimeNo || "").trim(); }

function norm(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitMulti(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  return text.split(/;|\n/).map((part) => part.trim()).filter(Boolean);
}

function rowKey(row, field) {
  const text = String(row[field] ?? "").trim();
  if (!text) return "";
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? String(parsed) : text;
}

function maxNumericId(rows, field) {
  return rows.reduce((max, row) => {
    const parsed = Number.parseInt(rowKey(row, field), 10);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
}

function makeIdAllocator(rows, field) {
  let current = maxNumericId(rows, field);
  return () => {
    current += 1;
    return String(current);
  };
}

function emptyRecord(headers) {
  return Object.fromEntries(headers.map((header) => [header, ""]));
}

function setCell(record, header, value) {
  if (header in record) record[header] = String(value ?? "");
}

function copyPreserved(record, existing, fields) {
  if (!existing) return;
  for (const field of fields) {
    if (field in record && !String(record[field] ?? "").trim()) {
      record[field] = String(existing[field] ?? "");
    }
  }
}

function existingByCaseAndName(rows, nameField) {
  const result = new Map();
  for (const row of rows) {
    const caseId = rowKey(row, "CaseMasterID");
    const name = norm(row[nameField]);
    if (caseId && name) result.set(`${caseId}::${name}`, row);
  }
  return result;
}

function replaceChildCases(existingRows, newRows, caseId) {
  const kept = existingRows.filter((row) => rowKey(row, "CaseMasterID") !== caseId);
  return kept.concat(newRows);
}

function buildAccusedRows(record, table) {
  const caseId = rowKey(record, "CaseMasterID");
  if (!caseId) return [];

  const existing = existingByCaseAndName(table.rows, "AccusedName");
  const nextId = makeIdAllocator(table.rows, "AccusedMasterID");
  const rows = [];

  for (const name of splitMulti(record.AccusedNames)) {
    const old = existing.get(`${caseId}::${norm(name)}`);
    const accusedId = rowKey(old || {}, "AccusedMasterID") || nextId();
    const row = emptyRecord(table.headers);
    setCell(row, "AccusedMasterID", accusedId);
    setCell(row, "CaseMasterID", caseId);
    setCell(row, "AccusedName", name);
    copyPreserved(row, old, ["AgeYear", "GenderID", "PersonID"]);
    rows.push(row);
  }

  return rows;
}

function buildVictimRows(record, table) {
  const caseId = rowKey(record, "CaseMasterID");
  if (!caseId) return [];

  const existing = existingByCaseAndName(table.rows, "VictimName");
  const nextId = makeIdAllocator(table.rows, "VictimMasterID");
  const rows = [];

  for (const name of splitMulti(record.VictimNames)) {
    const old = existing.get(`${caseId}::${norm(name)}`);
    const row = emptyRecord(table.headers);
    setCell(row, "VictimMasterID", rowKey(old || {}, "VictimMasterID") || nextId());
    setCell(row, "CaseMasterID", caseId);
    setCell(row, "VictimName", name);
    copyPreserved(row, old, ["AgeYear", "GenderID", "VictimPolice"]);
    rows.push(row);
  }

  return rows;
}

function buildComplainantRows(record, table) {
  const caseId = rowKey(record, "CaseMasterID");
  const name = String(record.Complainant ?? "").trim();
  if (!caseId || !name) return [];

  const existing = existingByCaseAndName(table.rows, "ComplainantName");
  const nextId = makeIdAllocator(table.rows, "ComplainantID");
  const old = existing.get(`${caseId}::${norm(name)}`);
  const row = emptyRecord(table.headers);
  setCell(row, "ComplainantID", rowKey(old || {}, "ComplainantID") || nextId());
  setCell(row, "CaseMasterID", caseId);
  setCell(row, "ComplainantName", name);
  copyPreserved(row, old, ["AgeYear", "OccupationID", "ReligionID", "CasteID", "GenderID"]);
  return [row];
}

async function syncChildTabs(record) {
  const caseId = rowKey(record, "CaseMasterID");
  if (!caseId) return;

  const [accused, victims, complainants] = await Promise.all([
    readTable(MASTER_SHEET_ID, "Accused"),
    readTable(MASTER_SHEET_ID, "Victim"),
    readTable(MASTER_SHEET_ID, "ComplainantDetails"),
  ]);

  const accusedHeaders = accused.headers.length ? accused.headers : ["AccusedMasterID", "CaseMasterID", "AccusedName"];
  const victimHeaders = victims.headers.length ? victims.headers : ["VictimMasterID", "CaseMasterID", "VictimName"];
  const complainantHeaders = complainants.headers.length
    ? complainants.headers
    : ["ComplainantID", "CaseMasterID", "ComplainantName"];

  const accusedTable = { headers: accusedHeaders, rows: accused.rows };
  const victimTable = { headers: victimHeaders, rows: victims.rows };
  const complainantTable = { headers: complainantHeaders, rows: complainants.rows };

  const newAccused = buildAccusedRows(record, accusedTable);
  const newVictims = buildVictimRows(record, victimTable);
  const newComplainants = buildComplainantRows(record, complainantTable);

  const writes = [];
  if (newAccused.length || accused.rows.some((row) => rowKey(row, "CaseMasterID") === caseId)) {
    writes.push(
      writeTable(
        MASTER_SHEET_ID,
        "Accused",
        accusedHeaders,
        replaceChildCases(accused.rows, newAccused, caseId),
      ),
    );
  }
  if (newVictims.length || victims.rows.some((row) => rowKey(row, "CaseMasterID") === caseId)) {
    writes.push(
      writeTable(
        MASTER_SHEET_ID,
        "Victim",
        victimHeaders,
        replaceChildCases(victims.rows, newVictims, caseId),
      ),
    );
  }
  if (newComplainants.length || complainants.rows.some((row) => rowKey(row, "CaseMasterID") === caseId)) {
    writes.push(
      writeTable(
        MASTER_SHEET_ID,
        "ComplainantDetails",
        complainantHeaders,
        replaceChildCases(complainants.rows, newComplainants, caseId),
      ),
    );
  }

  await Promise.all(writes);
}

let casesCache = { data: null, expiresAt: 0 };

// Historic records live in CaseMaster, while newer portal records are also
// written to Consolidated_Cases.  Reading just the latter made all pages show
// only the small subset that had already been synced there.  Build the portal
// dataset from both sources and let the consolidated copy win for duplicate
// records, as it contains the latest portal updates.
export function mergeCaseTables(master, consolidated) {
  const headers = [...new Set([...master.headers, ...consolidated.headers])];
  const merged = new Map();
  const unkeyed = [];

  for (const row of [...master.rows, ...consolidated.rows]) {
    const key = recordKey(row);
    if (!key) {
      unkeyed.push(row);
      continue;
    }
    merged.set(key, { ...(merged.get(key) || {}), ...row });
  }
  return { headers, rows: [...merged.values(), ...unkeyed] };
}

export async function casesFromGoogle() {
  if (casesCache.data && casesCache.expiresAt > Date.now()) {
    return casesCache.data;
  }

  const consolidatedTab = process.env.GOOGLE_CONSOLIDATED_TAB || "Consolidated_Cases";
  const [master, consolidated] = await Promise.all([
    readTable(MASTER_SHEET_ID, "CaseMaster"),
    CONSOLIDATED_SHEET_ID
      ? readTable(CONSOLIDATED_SHEET_ID, consolidatedTab)
      : Promise.resolve({ headers: [], rows: [] }),
  ]);
  const data = mergeCaseTables(master, consolidated);
  casesCache = { data, expiresAt: Date.now() + 15000 };
  return data;
}
export async function upsertCaseInGoogle(record) {
  const tab = process.env.GOOGLE_CONSOLIDATED_TAB || "Consolidated_Cases";
  const consolidated = await readTable(CONSOLIDATED_SHEET_ID, tab);
  
  let headers = [...consolidated.headers];
  let headersChanged = false;
  if (!headers.length) {
    headers = Object.keys(record);
    headersChanged = true;
  } else {
    for (const key of Object.keys(record)) {
      if (!headers.includes(key)) {
        headers.push(key);
        headersChanged = true;
      }
    }
  }

  const key = recordKey(record);
  const index = consolidated.rows.findIndex((row) => recordKey(row) === key);
  
  // Fill empty header gaps or update headers row if new columns were added
  if (headersChanged) {
    if (consolidated.rows.length === 0) {
      await writeTable(CONSOLIDATED_SHEET_ID, tab, headers, []);
    } else {
      await updateRow(CONSOLIDATED_SHEET_ID, tab, 1, headers);
    }
  }
  
  const rowArray = headers.map(h => String(record[h] || ""));
  if (index >= 0) {
    await updateRow(CONSOLIDATED_SHEET_ID, tab, index + 2, rowArray);
  } else {
    await appendRow(CONSOLIDATED_SHEET_ID, tab, rowArray);
  }

  const master = await readTable(MASTER_SHEET_ID, "CaseMaster");
  let masterHeaders = [...master.headers];
  let masterHeadersChanged = false;
  
  if (!masterHeaders.length) {
    masterHeaders = Object.keys(record);
    masterHeadersChanged = true;
  } else {
    for (const k of Object.keys(record)) {
      if (!masterHeaders.includes(k)) {
        masterHeaders.push(k);
        masterHeadersChanged = true;
      }
    }
  }

  if (masterHeadersChanged && master.rows.length > 0) {
    await updateRow(MASTER_SHEET_ID, "CaseMaster", 1, masterHeaders);
  }

  if (masterHeaders.length) {
    const masterRowArray = masterHeaders.map((header) => String(record[header] || ""));
    const masterIndex = master.rows.findIndex((row) => recordKey(row) === key);
    if (masterIndex >= 0) {
      await updateRow(MASTER_SHEET_ID, "CaseMaster", masterIndex + 2, masterRowArray);
    } else {
      await appendRow(MASTER_SHEET_ID, "CaseMaster", masterRowArray);
    }
  }

  await syncChildTabs(record);
  
  casesCache = { data: null, expiresAt: 0 };
  return record;
}

export async function employeeById(employeeId) {
  const table = await readTable(MASTER_SHEET_ID, "Employee");
  const target = String(employeeId || "").trim().toLowerCase();
  const rawId = target.replace(/^(emp|ksp|kgid)[-_\s]*/i, "");
  const row = table.rows.find((item) => {
    const id = String(item.EmployeeID || "").trim().toLowerCase();
    const kgid = String(item.KGID || "").trim().toLowerCase();
    return id === target || (rawId && id === rawId) || kgid === target || (rawId && kgid.toLowerCase().endsWith(rawId));
  });
  return { table, row };
}
export async function updateEmployee(employeeId, changes) {
  const { table, row } = await employeeById(employeeId);
  if (!row) throw new Error("Employee was not found in the Employee sheet.");
  const index = table.rows.indexOf(row);
  const updatedRow = { ...row, ...changes };
  const headers = [...table.headers];
  let headersChanged = false;

  for (const key of Object.keys(changes)) {
    if (!headers.includes(key)) {
      headers.push(key);
      headersChanged = true;
    }
  }

  if (headersChanged) {
    await updateRow(MASTER_SHEET_ID, "Employee", 1, headers);
  }
  await updateRow(
    MASTER_SHEET_ID,
    "Employee",
    index + 2,
    headers.map((header) => String(updatedRow[header] ?? "")),
  );
  return updatedRow;
}
