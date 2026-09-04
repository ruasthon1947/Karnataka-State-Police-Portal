import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import "./env.mjs";
import { appendRow, readTable, writeTable } from "./googleSheets.mjs";

export const AUDIT_HEADERS = Object.freeze([
  "EventID",
  "Timestamp",
  "OfficerID",
  "OfficerName",
  "Role",
  "PoliceStation",
  "Action",
  "TargetType",
  "TargetID",
  "Result",
  "StatusCode",
  "Details",
  "RequestID",
  "PreviousHash",
  "EventHash",
]);

const MAX_LOCAL_EVENTS = 10_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const runtimeSecret = crypto.randomBytes(48);

function clean(value, maximum = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function cleanDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return "{}";
  const safe = {};
  for (const [key, value] of Object.entries(details).slice(0, 20)) {
    const safeKey = clean(key, 80);
    if (!safeKey) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      safe[safeKey] = value;
    } else if (Array.isArray(value)) {
      safe[safeKey] = value.slice(0, 20).map((item) => clean(item, 160));
    } else {
      safe[safeKey] = clean(value, 500);
    }
  }
  return JSON.stringify(safe).slice(0, 3_000);
}

function configuredSecret(override) {
  const value = override || process.env.AUDIT_HMAC_SECRET || process.env.SESSION_SECRET;
  if (value) return Buffer.from(String(value));
  return runtimeSecret;
}

function canonicalEvent(event) {
  return AUDIT_HEADERS
    .filter((header) => header !== "EventHash")
    .map((header) => `${header.length}:${header}=${String(event[header] ?? "").length}:${String(event[header] ?? "")}`)
    .join("|");
}

function eventHash(event, secret) {
  return crypto.createHmac("sha256", secret).update(canonicalEvent(event)).digest("hex");
}

function hashesMatch(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeStoredEvent(row) {
  return Object.fromEntries(AUDIT_HEADERS.map((header) => [header, String(row?.[header] ?? "")]));
}

function actionMatches(event, filters) {
  if (filters.action && event.Action !== filters.action) return false;
  if (filters.result && event.Result !== filters.result) return false;
  if (filters.from && event.Timestamp.slice(0, 10) < filters.from) return false;
  if (filters.to && event.Timestamp.slice(0, 10) > filters.to) return false;
  if (filters.query) {
    const needle = filters.query.toLocaleLowerCase();
    const haystack = [
      event.OfficerID,
      event.OfficerName,
      event.Role,
      event.PoliceStation,
      event.Action,
      event.TargetType,
      event.TargetID,
      event.Result,
      event.Details,
    ]
      .join(" ")
      .toLocaleLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function createAuditService(options = {}) {
  const localPath = path.resolve(
    options.localPath ||
      process.env.AUDIT_LOCAL_PATH ||
      path.join(process.cwd(), ".runtime", "audit-events.jsonl"),
  );
  const sheetId = clean(
    options.sheetId ??
      process.env.GOOGLE_AUDIT_SHEET_ID ??
      process.env.GOOGLE_MASTER_SHEET_ID ??
      process.env.GOOGLE_SHEET_ID,
    240,
  );
  const tab = clean(options.tab ?? process.env.GOOGLE_AUDIT_TAB ?? "AuditTrail", 80) || "AuditTrail";
  const secret = configuredSecret(options.secret);
  const useRemote = options.useRemote ?? Boolean(sheetId);
  let queue = Promise.resolve();

  async function readLocal() {
    try {
      const text = await fs.readFile(localPath, "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return normalizeStoredEvent(JSON.parse(line));
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-MAX_LOCAL_EVENTS);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function appendLocal(event) {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.appendFile(localPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async function readRemote() {
    if (!useRemote || !sheetId) return [];
    const table = await readTable(sheetId, tab);
    if (!table.headers.length) {
      await writeTable(sheetId, tab, AUDIT_HEADERS, []);
      return [];
    }
    if (AUDIT_HEADERS.some((header, index) => table.headers[index] !== header)) {
      throw new Error(`The ${tab} tab has an unexpected header layout.`);
    }
    return table.rows.map(normalizeStoredEvent);
  }

  async function syncRemote(localEvents) {
    if (!useRemote || !sheetId) return { synced: false, remoteEvents: [] };
    const remoteEvents = await readRemote();
    const remoteIds = new Set(remoteEvents.map((event) => event.EventID));
    const pending = localEvents.filter((event) => event.EventID && !remoteIds.has(event.EventID));
    for (const event of pending) {
      await appendRow(sheetId, tab, AUDIT_HEADERS.map((header) => event[header] || ""));
      remoteEvents.push(event);
    }
    return { synced: true, remoteEvents };
  }

  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function record({ session, action, targetType, targetId, result = "SUCCESS", statusCode = 200, details = {}, requestId = "" }) {
    return serialize(async () => {
      const existing = await readLocal();
      const previousHash = existing.at(-1)?.EventHash || "GENESIS";
      const event = {
        EventID: crypto.randomUUID(),
        Timestamp: new Date().toISOString(),
        OfficerID: clean(session?.employeeId || "SYSTEM", 120),
        OfficerName: clean(session?.name || "System", 160),
        Role: clean(session?.role || "System", 80),
        PoliceStation: clean(session?.policeStation || "", 200),
        Action: clean(action, 80),
        TargetType: clean(targetType, 80),
        TargetID: clean(targetId, 240),
        Result: clean(result, 40) || "SUCCESS",
        StatusCode: clean(statusCode, 12),
        Details: cleanDetails(details),
        RequestID: clean(requestId || crypto.randomUUID(), 120),
        PreviousHash: previousHash,
        EventHash: "",
      };
      event.EventHash = eventHash(event, secret);
      await appendLocal(event);

      let remoteSynced = false;
      let remoteError = "";
      try {
        const sync = await syncRemote([...existing, event]);
        remoteSynced = sync.synced;
      } catch (error) {
        remoteError = clean(error?.message || error, 300);
        console.error("[Audit Trail] Persistent sync is pending.", { message: remoteError });
      }
      return { event, remoteSynced, remoteError };
    });
  }

  async function list(filters = {}) {
    return serialize(async () => {
      const localEvents = await readLocal();
      let remoteEvents = [];
      let remoteSynced = false;
      let remoteError = "";
      try {
        const sync = await syncRemote(localEvents);
        remoteEvents = sync.remoteEvents;
        remoteSynced = sync.synced;
      } catch (error) {
        remoteError = clean(error?.message || error, 300);
        console.error("[Audit Trail] Could not read the persistent store.", { message: remoteError });
      }

      const byId = new Map();
      for (const event of [...remoteEvents, ...localEvents]) {
        if (event.EventID) byId.set(event.EventID, event);
      }
      const all = Array.from(byId.values()).sort((a, b) =>
        b.Timestamp.localeCompare(a.Timestamp) || b.EventID.localeCompare(a.EventID),
      );
      const checked = all.length;
      const broken = all.filter((event) => !hashesMatch(event.EventHash, eventHash(event, secret)));
      const limit = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, Number.parseInt(String(filters.limit || DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
      );
      const query = clean(filters.query, 160).toLocaleLowerCase();
      const normalizedFilters = {
        action: clean(filters.action, 80),
        result: clean(filters.result, 40),
        from: clean(filters.from, 10),
        to: clean(filters.to, 10),
        query,
      };
      const matching = all.filter((event) => actionMatches(event, normalizedFilters));
      return {
        events: matching.slice(0, limit),
        total: matching.length,
        integrity: {
          verified: broken.length === 0,
          checked,
          brokenEventIds: broken.slice(0, 10).map((event) => event.EventID),
        },
        storage: {
          persistent: Boolean(useRemote && sheetId && remoteSynced),
          mode: useRemote && sheetId ? "Google Sheets + local write-ahead log" : "Local write-ahead log",
          syncPending: Boolean(useRemote && sheetId && !remoteSynced),
          error: remoteError,
        },
      };
    });
  }

  return { list, record, localPath };
}

export const auditService = createAuditService();

export async function recordAuditEventSafe(event) {
  try {
    return await auditService.record(event);
  } catch (error) {
    console.error("[Audit Trail] Event could not be written.", {
      action: clean(event?.action, 80),
      message: clean(error?.message || error, 300),
    });
    return { event: null, remoteSynced: false, remoteError: clean(error?.message || error, 300) };
  }
}
