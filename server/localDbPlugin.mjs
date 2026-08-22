import { casesFromGoogle, upsertCaseInGoogle, employeeById, updateEmployee, writeTable, readTable } from "./googleSheets.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { OtpError, normalizeIndianPhoneNumber, otpService } from "./otpService.mjs";
import {
  caseAlertService,
  getSmsProviderStatus,
  parseNotificationPreferences,
  serializeNotificationPreferences,
} from "./smsService.mjs";
import {
  canAccessCase,
  checkLoginRateLimit,
  clearLoginRateLimit,
  clearSessionCookie,
  filterCasesForSession,
  hashPassword,
  profileFromEmployee,
  readSession,
  requireSession,
  sessionUser,
  setSessionCookie,
  verifyFirebaseIdToken,
  verifyPassword,
} from "./security.mjs";

const execFileAsync = promisify(execFile);

function normalizeValue(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).join("; ");
  }
  return String(value).trim();
}

/**
 * Normalizes crime numbers for flexible matching.
 * E.g., "CR-0011/2026", "0011/2026", and "11/2026" all normalize to "11/2026".
 */
function normalizeCrimeNo(str) {
  if (!str) return "";
  const cleaned = String(str)
    .trim()
    .toUpperCase()
    .replace(/^CR-?/i, ""); // Strip leading "CR-" or "CR"

  const parts = cleaned.split("/");
  if (parts.length === 2) {
    const seq = parts[0].replace(/^0+/, ""); // Strip leading zeros from sequence
    return `${seq}/${parts[1]}`;
  }
  return cleaned;
}

function splitList(value) {
  return String(value || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

const OPTION_FIELDS = [
  "CrimeHead", "CrimeSubHead", "PoliceStation", "PoliceStationType", "District",
  "Court", "Officer", "OfficerRank", "OfficerDesignation", "Status",
  "CaseCategory", "Gravity", "Acts", "Sections", "ChargesheetStatus"
];

function cleanOption(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function optionKey(value) {
  return cleanOption(value).toLocaleLowerCase();
}

export function buildOptions(records) {
  const options = {};
  for (const field of OPTION_FIELDS) {
    const values = new Map();
    for (const record of records) {
      for (const value of splitList(record[field])) {
        const cleaned = cleanOption(value);
        const key = optionKey(cleaned);
        if (key && !values.has(key)) values.set(key, cleaned);
      }
    }
    options[field] = Array.from(values.values()).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }

  const heads = new Map();
  for (const record of records) {
    const head = cleanOption(record.CrimeHead);
    if (!head) continue;
    const headKey = optionKey(head);
    if (!heads.has(headKey)) heads.set(headKey, { label: head, values: new Map() });
    for (const subHead of splitList(record.CrimeSubHead)) {
      const cleaned = cleanOption(subHead);
      const key = optionKey(cleaned);
      if (key && !heads.get(headKey).values.has(key)) {
        heads.get(headKey).values.set(key, cleaned);
      }
    }
  }
  const crimeSubHeadsByHead = {};
  for (const { label, values } of heads.values()) {
    crimeSubHeadsByHead[label] = Array.from(values.values()).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }
  options.crimeSubHeadsByHead = crimeSubHeadsByHead;

  return options;
}

function generateCrimeNo(records) {
  const currentYear = new Date().getFullYear();
  let maxSeq = 0;
  for (const record of records) {
    const parts = String(record.CrimeNo || "").split("/");
    if (parts.length === 2 && parts[1] === String(currentYear)) {
      const seq = parseInt(parts[0].replace(/^0+/, ""), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  }
  return `${String(maxSeq + 1).padStart(4, "0")}/${currentYear}`;
}

function nextNumericValue(records, field, fallback) {
  const max = records.reduce((current, record) => {
    const n = Number.parseInt(record[field], 10);
    return Number.isFinite(n) ? Math.max(current, n) : current;
  }, 0);
  return String(max > 0 ? max + 1 : fallback);
}

function recalcDerivedFields(record) {
  record.AccusedCount = String(splitList(record.AccusedNames).length);
  record.VictimCount = String(splitList(record.VictimNames).length);
  if (!record.ArrestCount) record.ArrestCount = "0";
  if (!record.ChargesheetCount) record.ChargesheetCount = "0";
  if (!record.ChargesheetStatus) record.ChargesheetStatus = "Pending";
  if (!record.Status) record.Status = "Under Investigation";
  if (!record.CaseCategory) record.CaseCategory = "FIR";
  if (!record.Gravity) record.Gravity = "Non-Heinous";
  if (!record.District) record.District = "Bangalore Urban";
}

function caseMatches(record, key) {
  const wanted = decodeURIComponent(String(key || "")).trim();
  if (!wanted) return false;

  const wantedNormalized = normalizeCrimeNo(wanted);

  // Exact match on CaseMasterID or CaseNo
  if (
    String(record.CaseMasterID || "").trim() === wanted ||
    String(record.CaseNo || "").trim() === wanted
  ) {
    return true;
  }

  // Flexible normalized match on CrimeNo
  if (record.CrimeNo) {
    const recordCrimeNormalized = normalizeCrimeNo(record.CrimeNo);
    if (recordCrimeNormalized === wantedNormalized) return true;
    if (String(record.CrimeNo).trim() === wanted) return true;
  }

  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 250_000) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function sendError(res, status, error) {
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
  if (error?.code) payload.code = error.code;
  if (Number.isFinite(error?.retryAfterSeconds)) {
    payload.retryAfterSeconds = error.retryAfterSeconds;
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
  }
  if (Number.isFinite(error?.attemptsRemaining)) {
    payload.attemptsRemaining = error.attemptsRemaining;
  }
  sendJson(res, status, payload);
}

function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

function employeeSubject(employeeId) {
  return String(employeeId || "").trim().toLowerCase();
}

export async function handleApi(req, res, next) {
  const url = new URL(req.url || "/", "http://local-db");
  
  // Pass AI endpoints directly to chatPlugin.mjs so this middleware does not
  // treat them as unknown API routes before the AI handler can run.
  if (url.pathname === "/api/chat" || url.pathname === "/api/fir-draft") {
    next();
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    next();
    return;
  }

  try {
    if (req.method === "POST" && url.pathname === "/api/login") {
      const { employeeId, password, firebaseIdToken } = await readBody(req);
      if (!employeeId || !password) {
        sendError(res, 400, "Employee ID and password are required.");
        return;
      }

      const rate = checkLoginRateLimit(clientKey(req), employeeId);
      if (!rate.ok) {
        res.setHeader("Retry-After", String(rate.retryAfterSeconds));
        sendError(
          res,
          429,
          `Too many sign-in attempts. Try again in ${rate.retryAfterSeconds} seconds.`,
        );
        return;
      }

      const { row } = await employeeById(employeeId);
      if (!row) {
        sendError(res, 401, "Invalid credentials.");
        return;
      }

      const firstLogin =
        String(row.HasLoggedIn || "").trim().toUpperCase() !== "TRUE";
      let firebaseVerified = false;
      if (firebaseIdToken) {
        try {
          firebaseVerified = await verifyFirebaseIdToken(
            firebaseIdToken,
            employeeId,
          );
        } catch {
          firebaseVerified = false;
        }
      }

      const passwordHashVerified = row.PasswordHash
        ? await verifyPassword(password, row.PasswordHash)
        : false;
      const temporaryPasswordVerified =
        firstLogin &&
        Boolean(row.FirstAuth) &&
        String(row.FirstAuth) === String(password);

      const firebaseFallbackVerified = !row.PasswordHash && firebaseVerified;
      if (!firebaseFallbackVerified && !passwordHashVerified && !temporaryPasswordVerified) {
        sendError(res, 401, "Invalid credentials.");
        return;
      }

      clearLoginRateLimit(clientKey(req), employeeId);
      const user = profileFromEmployee(row, employeeId);
      const createdSession = setSessionCookie(req, res, user);
      sendJson(res, 200, {
        ok: true,
        user,
        sessionExpiresAt: createdSession.expiresAt,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      const current = readSession(req);
      if (!current) {
        sendError(res, 401, "Your session has expired. Please sign in again.");
        return;
      }
      sendJson(res, 200, {
        ok: true,
        user: sessionUser(current),
        sessionExpiresAt: current.exp,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      clearSessionCookie(req, res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, service: "kspp-portal" });
      return;
    }

    const session = requireSession(req, res);
    if (!session) return;

    if (req.method === "POST" && url.pathname === "/api/session/extend") {
      const extended = setSessionCookie(req, res, sessionUser(session));
      sendJson(res, 200, {
        ok: true,
        user: sessionUser(extended.payload),
        sessionExpiresAt: extended.expiresAt,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/employee/password") {
      const { currentPassword, newPassword, firebaseIdToken } = await readBody(req);
      const { row } = await employeeById(session.employeeId);
      if (!row) {
        sendError(res, 404, "Employee was not found.");
        return;
      }
      const firstLogin =
        String(row.HasLoggedIn || "").trim().toUpperCase() !== "TRUE";
      const hashVerified = row.PasswordHash
        ? await verifyPassword(currentPassword, row.PasswordHash)
        : false;
      const temporaryPasswordVerified =
        firstLogin &&
        Boolean(row.FirstAuth) &&
        String(row.FirstAuth) === String(currentPassword);
      let firebaseVerified = false;
      if (!row.PasswordHash && firebaseIdToken) {
        try {
          firebaseVerified = await verifyFirebaseIdToken(
            firebaseIdToken,
            session.employeeId,
          );
        } catch {
          firebaseVerified = false;
        }
      }
      if (!hashVerified && !temporaryPasswordVerified && !firebaseVerified) {
        sendError(res, 401, "Incorrect current password.");
        return;
      }
      const passwordHash = await hashPassword(newPassword || "");
      await updateEmployee(session.employeeId, {
        FirstAuth: "",
        PasswordHash: passwordHash,
        HasLoggedIn: "TRUE",
      });
      const user = { ...sessionUser(session), isFirstLogin: false };
      const updatedSession = setSessionCookie(req, res, user);
      sendJson(res, 200, {
        ok: true,
        user,
        sessionExpiresAt: updatedSession.expiresAt,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send-otp") {
      const { phoneNumber } = await readBody(req);
      const { row } = await employeeById(session.employeeId);
      if (!row) {
        sendError(res, 404, "Employee was not found.");
        return;
      }

      try {
        const result = await otpService.request({
          subject: employeeSubject(session.employeeId),
          phoneNumber,
          clientKey: clientKey(req),
        });
        sendJson(res, 200, {
          ok: true,
          message: "OTP sent successfully.",
          expiresInSeconds: result.expiresInSeconds,
          retryAfterSeconds: result.retryAfterSeconds,
        });
      } catch (err) {
        const status = err instanceof OtpError ? err.status : 500;
        sendError(res, status, err);
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/verify-otp") {
      const { phoneNumber, otp } = await readBody(req);

      try {
        const result = await otpService.verifyAndRun(
          {
            subject: employeeSubject(session.employeeId),
            phoneNumber,
            code: otp,
          },
          async ({ phoneNumber: verifiedPhoneNumber }) => {
            try {
              await updateEmployee(session.employeeId, {
                PhoneNumber: verifiedPhoneNumber,
                PhoneVerifiedAt: new Date().toISOString(),
              });
            } catch (error) {
              console.error("[OTP] Verified phone could not be saved", {
                employeeId: session.employeeId,
                error: error?.message || String(error),
              });
              throw new OtpError(
                "The OTP is correct, but the phone number could not be saved. Please try verifying again.",
                "PHONE_SAVE_FAILED",
                502,
              );
            }
          },
        );
        sendJson(res, 200, {
          ok: true,
          message: "Phone number verified and saved.",
          phoneNumber: result.phoneNumber,
        });
      } catch (err) {
        const status = err instanceof OtpError ? err.status : 500;
        sendError(res, status, err);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/phone") {
      const { row } = await employeeById(session.employeeId);
      if (!row) {
        sendError(res, 404, "Employee was not found.");
        return;
      }

      let phoneNumber = "";
      try {
        if (row.PhoneNumber) {
          phoneNumber = normalizeIndianPhoneNumber(row.PhoneNumber);
        }
      } catch {
        phoneNumber = "";
      }
      sendJson(res, 200, {
        ok: true,
        phoneNumber,
        verified: Boolean(phoneNumber && row.PhoneVerifiedAt),
        verifiedAt: row.PhoneVerifiedAt || null,
        preferences: parseNotificationPreferences(row.NotificationPref),
        sms: getSmsProviderStatus(),
      });
      return;
    }

    if (
      (req.method === "PUT" || req.method === "POST") &&
      url.pathname === "/api/notification-preferences"
    ) {
      const { newFir, statusUpdates } = await readBody(req);
      const { row } = await employeeById(session.employeeId);
      if (!row) {
        sendError(res, 404, "Employee was not found.");
        return;
      }
      const current = parseNotificationPreferences(row.NotificationPref);
      const preferences = {
        newFir: typeof newFir === "boolean" ? newFir : current.newFir,
        statusUpdates:
          typeof statusUpdates === "boolean" ? statusUpdates : current.statusUpdates,
      };
      await updateEmployee(session.employeeId, {
        NotificationPref: serializeNotificationPreferences(preferences),
      });
      sendJson(res, 200, { ok: true, preferences });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/phone") {
      sendError(
        res,
        405,
        "Phone numbers can only be saved after OTP verification.",
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cases") {
      const { headers, rows } = await casesFromGoogle();
      sendJson(res, 200, {
        ok: true,
        headers,
        // Dashboard, reports, and reference directories are statewide shared
        // views.  Restricting this collection to a constable's assignments
        // made the portal report only 8 records instead of the full register.
        // Edit permissions remain enforced below on save routes.
        cases: rows,
        options: buildOptions(rows),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cases/sync") {
      sendJson(res, 200, { ok: true, sync: { ok: true, skipped: true, message: "Sync handled dynamically via Node.js" } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cases/pull") {
      try {
        const tempCsv = path.join(process.cwd(), "scratch", "temp_sync.csv");
        const exportScript = path.join(process.cwd(), "local_db", "export_data.py");
        const env = { ...process.env, GOOGLE_SERVICE_ACCOUNT_JSON: process.env.CATALYST_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON };
        const consolidatedSheetId = String(
          process.env.GOOGLE_CONSOLIDATED_SHEET_ID || "",
        ).trim();
        if (!consolidatedSheetId) {
          throw new Error("GOOGLE_CONSOLIDATED_SHEET_ID is not configured.");
        }
        
        await execFileAsync(
          process.env.PYTHON_EXECUTABLE || "python",
          [exportScript, "--output", tempCsv],
          { env },
        );
        
        if (fs.existsSync(tempCsv)) {
          const csvData = fs.readFileSync(tempCsv, "utf8");
          const records = parse(csvData, { columns: true, skip_empty_lines: true });
          if (records.length > 0) {
            const headers = Object.keys(records[0]);
            const tab = process.env.GOOGLE_CONSOLIDATED_TAB || "Consolidated_Cases";
            
            await writeTable(consolidatedSheetId, tab, headers, records);
          }
          fs.unlinkSync(tempCsv); // Cleanup
        }
        
        const { headers, rows } = await casesFromGoogle();
        sendJson(res, 200, {
          ok: true,
          pull: { ok: true },
          writeResult: { pending: false },
          headers,
          cases: rows,
          options: buildOptions(rows),
        });
      } catch (err) {
        console.error("[Case Sync] Pull failed.", err);
        sendError(res, 500, "Case sync failed. Please try again or contact support.");
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/patrol-alert") {
      const payload = await readBody(req);
      const station = normalizeValue(payload.station);
      const zone = normalizeValue(payload.zone);
      const mode = normalizeValue(payload.mode);
      const peakWindow = normalizeValue(payload.peakWindow);
      const risk = Number(payload.risk);
      if (!station || !zone || !Number.isFinite(risk) || risk < 0 || risk > 100) {
        sendError(res, 400, "A valid station, zone, and intelligence score are required.");
        return;
      }

      const masterSheetId = String(
        process.env.GOOGLE_MASTER_SHEET_ID || process.env.GOOGLE_SHEET_ID || "",
      ).trim();
      if (!masterSheetId) {
        sendError(res, 503, "The employee directory is not configured.");
        return;
      }

      const [employeesTab, unitsTab] = await Promise.all([
        readTable(masterSheetId, "Employee"),
        readTable(masterSheetId, "Unit"),
      ]);
      const notifications = await caseAlertService.notify({
        event: "patrol_alert",
        record: {
          PoliceStation: station,
          ZoneName: zone,
          RiskPercentage: Math.round(risk),
          RiskMode: mode || "Crime intelligence alert",
          PeakWindow: peakWindow,
          RequestedBy: session.employeeId,
        },
        employees: employeesTab.rows,
        units: unitsTab.rows,
      });
      console.log("[SMS Alerts] Patrol deployment result", {
        requestedBy: session.employeeId,
        station,
        matched: notifications.matched,
        eligible: notifications.eligible,
        sent: notifications.sent,
        failed: notifications.failed,
      });
      sendJson(res, 200, { ok: true, notifications });
      return;
    }

    const caseMatch = url.pathname.match(/^\/api\/cases\/([^/]+)$/);
    if (req.method === "GET" && caseMatch) {
      const { headers, rows } = await casesFromGoogle();
      const record = rows.find((item) => caseMatches(item, caseMatch[1]));
      if (!record) {
        sendError(res, 404, "Case was not found.");
        return;
      }
      sendJson(res, 200, {
        ok: true,
        headers,
        case: record,
        options: buildOptions(rows),
      });
      return;
    }

    if ((req.method === "POST" && url.pathname === "/api/cases") || ((req.method === "PATCH" || req.method === "PUT") && caseMatch)) {
      const payload = await readBody(req);
      const { headers, rows: records } = await casesFromGoogle();
      const fields = payload.case || payload.fields || payload;
      
      const key = caseMatch ? caseMatch[1] : "";
      
      const knownFields = {};
      for (const [k, value] of Object.entries(fields)) {
        knownFields[k] = normalizeValue(value);
      }

      let index = records.findIndex((record) => caseMatches(record, key || knownFields.CrimeNo || knownFields.CaseNo || knownFields.CaseMasterID));
      const created = index === -1;
      const previousRecord = created ? null : { ...records[index] };
      if (!created && !canAccessCase(session, previousRecord)) {
        sendError(res, 403, "You do not have permission to update this case.");
        return;
      }
      
      const record = {};
      headers.forEach((header) => {
        record[header] = created ? "" : records[index][header] || "";
      });
      Object.assign(record, knownFields);
      if (created) record.FiledBy = session.employeeId;
      if (session.role === "Constable" && !record.PoliceStation && session.policeStation) {
        record.PoliceStation = session.policeStation;
      }
      if (!canAccessCase(session, record)) {
        sendError(res, 403, "You can only save cases assigned to you or your police station.");
        return;
      }

      // 🚀 Safe Auto-ID Generation if missing or invalid
      if (!record.CaseMasterID || record.CaseMasterID === "Assigned on save") {
        record.CaseMasterID = nextNumericValue(records, "CaseMasterID", 1222);
      }
      if (!record.CaseNo || record.CaseNo === "Assigned on save") {
        const year = new Date().getFullYear();
        record.CaseNo = `${year}${String(records.length + 1).padStart(6, "0")}`;
      }
      if (!record.CrimeNo || record.CrimeNo === "Assigned on save") {
        record.CrimeNo = generateCrimeNo(records);
      }
      recalcDerivedFields(record);

      const optionRecords = filterCasesForSession(
        session,
        created
          ? [...records, record]
          : records.map((item, itemIndex) => (itemIndex === index ? record : item)),
      );

      if (payload.skipSync) {
        sendError(res, 400, "Drafts are saved securely in the browser. Remove skipSync to submit the FIR.");
        return;
      }
      
      // 🚀 Direct Google Sheets Upsert with explicit logging
      console.log(`[Google Sheets Write] Upserting record for CaseMasterID: ${record.CaseMasterID}...`);
      try {
        await upsertCaseInGoogle(record);
        console.log(`[Google Sheets Write] ✅ Successfully wrote CaseMasterID ${record.CaseMasterID} to Google Sheets!`);
      } catch (googleErr) {
        console.error(`[Google Sheets Write Error] ❌ Failed to write to Google Sheets:`, googleErr);
        throw new Error(`Google Sheets API write error: ${googleErr.message || String(googleErr)}`);
      }
      
      const statusChanged =
        previousRecord &&
        normalizeValue(previousRecord.Status).toLocaleLowerCase() !==
          normalizeValue(record.Status).toLocaleLowerCase();
      const notificationEvent = created
        ? "new_fir"
        : statusChanged
          ? "status_update"
          : "";
      let notifications = null;

      if (notificationEvent) {
        try {
          const masterSheetId = String(
            process.env.GOOGLE_MASTER_SHEET_ID || process.env.GOOGLE_SHEET_ID || "",
          ).trim();
          if (!masterSheetId) {
            throw new Error("GOOGLE_MASTER_SHEET_ID is not configured.");
          }
          const employeesTab = await readTable(masterSheetId, "Employee");
          const unitsTab = await readTable(masterSheetId, "Unit");
          notifications = await caseAlertService.notify({
            event: notificationEvent,
            record,
            previousRecord: previousRecord || {},
            employees: employeesTab.rows,
            units: unitsTab.rows,
          });
          console.log("[SMS Alerts] FIR notification result", {
            event: notifications.event,
            matched: notifications.matched,
            eligible: notifications.eligible,
            sent: notifications.sent,
            failed: notifications.failed,
          });
        } catch (error) {
          console.error("[SMS Alerts] Notification routing failed", {
            event: notificationEvent,
            error: error?.message || String(error),
          });
          notifications = {
            event: notificationEvent,
            matched: 0,
            eligible: 0,
            sent: 0,
            failed: 1,
            systemError: true,
          };
        }
      }

      sendJson(res, 200, {
        ok: true,
        created,
        headers,
        case: record,
        options: buildOptions(optionRecords),
        notifications,
        sync: { ok: true, skipped: false, message: "Directly saved to Google Sheets" },
      });
      return;
    }

    sendError(res, 404, "Unknown API endpoint.");
  } catch (error) {
    console.error("[Local DB Handler Exception]:", error);
    const status = error?.status || 500;
    sendError(
      res,
      status,
      status >= 500
        ? "The service could not complete this request. Please try again."
        : error,
    );
  }
}

function localDbPlugin() {
  return {
    name: "local-db-api",
    configureServer(server) {
      server.middlewares.use(handleApi);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleApi);
    },
  };
}

export default localDbPlugin;

