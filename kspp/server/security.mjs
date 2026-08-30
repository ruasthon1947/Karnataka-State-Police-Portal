import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "kspp_session";
const SESSION_TTL_MS = positiveInteger(
  process.env.SESSION_TTL_MS,
  30 * 60 * 1000,
  5 * 60 * 1000,
  12 * 60 * 60 * 1000,
);
const runtimeSessionSecret = crypto.randomBytes(48);
const loginAttempts = new Map();
const chatRequests = new Map();
const speechRequests = new Map();
const ttsRequests = new Map();

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function sessionSecret() {
  const configured = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && !configured) {
    throw new Error("SESSION_SECRET is required in production.");
  }
  return configured ? Buffer.from(configured) : runtimeSessionSecret;
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

function secureCookie(req) {
  const forwardedProtocol = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return forwardedProtocol === "https" || Boolean(req.socket?.encrypted);
}

function cookieHeader(req, token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    // Lax keeps the login cookie across ordinary browser reloads and the
    // AppSail redirect flow while still protecting cross-site POST requests.
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  // AppSail sits behind a proxy that does not consistently pass
  // X-Forwarded-Proto.  Forcing Secure solely from NODE_ENV makes browsers
  // discard the login cookie on those deployments, so every page reload
  // appears logged out.  Set it when this request is actually known to be
  // HTTPS; browsers served over HTTPS still accept the cookie if the proxy
  // omits that header.
  if (secureCookie(req)) parts.push("Secure");
  return parts.join("; ");
}

export function createSessionToken(user, options = {}) {
  const now = options.now ?? Date.now();
  const expiresAt = options.expiresAt ?? now + SESSION_TTL_MS;
  const payload = {
    employeeId: String(user.employeeId || "").trim(),
    name: String(user.name || "Officer").trim(),
    role: normalizeRole(user.role),
    policeStation: String(user.policeStation || "").trim(),
    isFirstLogin: Boolean(user.isFirstLogin),
    iat: now,
    exp: expiresAt,
  };
  const encoded = base64urlJson(payload);
  return {
    expiresAt,
    payload,
    token: `${encoded}.${sign(encoded)}`,
  };
}

export function setSessionCookie(req, res, user, options = {}) {
  const session = createSessionToken(user, options);
  res.setHeader(
    "Set-Cookie",
    cookieHeader(req, session.token, (session.expiresAt - Date.now()) / 1000),
  );
  return session;
}

export function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", cookieHeader(req, "", 0));
}

export function readSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const [encoded, signature, ...rest] = token.split(".");
  if (!encoded || !signature || rest.length || !safeEqual(sign(encoded), signature)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      !payload?.employeeId ||
      !Number.isFinite(payload?.exp) ||
      payload.exp <= Date.now()
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function requireSession(req, res) {
  const session = readSession(req);
  if (session) return session;
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ ok: false, error: "Your session has expired. Please sign in again." }));
  return null;
}

export function normalizeRole(value) {
  const text = String(value || "").trim().toLowerCase();
  if (
    /\b(sp|superintendent|commissioner|dcp|acp|administrator|admin)\b/.test(text)
  ) {
    return "SP";
  }
  if (/\b(inspector|psi|sub[- ]?inspector|si)\b/.test(text)) {
    return "Inspector";
  }
  return "Constable";
}

export function profileFromEmployee(row, employeeId) {
  const id = String(employeeId || row?.EmployeeID || row?.KGID || "").trim();
  const name =
    String(row?.Name || "").trim() ||
    [row?.FirstName, row?.MiddleName, row?.LastName]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ") ||
    `Officer ${id}`;
  const roleSource =
    row?.Role ||
    row?.OfficerRank ||
    row?.Rank ||
    row?.Designation ||
    row?.OfficerDesignation;
  const policeStation =
    row?.PoliceStation ||
    row?.Station ||
    row?.StationName ||
    row?.UnitName ||
    row?.Unit ||
    row?.UnitID ||
    "";
  return {
    employeeId: id,
    name,
    role: normalizeRole(roleSource),
    policeStation: String(policeStation || "").trim(),
    isFirstLogin: String(row?.HasLoggedIn || "").trim().toUpperCase() !== "TRUE",
  };
}

function normalized(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\bpolice\s+station\b/g, "ps")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function canAccessCase(session, record) {
  if (!session || !record) return false;
  if (session.role !== "Constable") return true;

  const sessionStation = normalized(session.policeStation);
  const recordStation = normalized(record.PoliceStation || record.Station);
  if (
    sessionStation &&
    recordStation &&
    (sessionStation === recordStation ||
      sessionStation.includes(recordStation) ||
      recordStation.includes(sessionStation))
  ) {
    return true;
  }

  const employeeId = normalized(session.employeeId).replace(/^(emp|ksp|kgid)\s+/, "");
  const assignedId = normalized(record.EmployeeID).replace(/^(emp|ksp|kgid)\s+/, "");
  if (employeeId && assignedId && (employeeId === assignedId || assignedId.endsWith(employeeId))) {
    return true;
  }
  return Boolean(
    normalized(session.name) &&
      normalized(record.Officer) &&
      normalized(session.name) === normalized(record.Officer),
  );
}

export function filterCasesForSession(session, records) {
  return (records || []).filter((record) => canAccessCase(session, record));
}

export async function hashPassword(password) {
  validateNewPassword(password);
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(password, encodedHash) {
  const [scheme, saltValue, hashValue, ...rest] = String(encodedHash || "").split("$");
  if (scheme !== "scrypt" || !saltValue || !hashValue || rest.length) return false;
  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = Buffer.from(
      await scrypt(password, Buffer.from(saltValue, "base64url"), expected.length),
    );
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function validateNewPassword(password) {
  const value = String(password || "");
  if (value.length < 8) {
    throw Object.assign(new Error("New password must be at least 8 characters."), {
      status: 400,
    });
  }
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    throw Object.assign(
      new Error("New password must contain at least one letter and one number."),
      { status: 400 },
    );
  }
  return value;
}

export async function verifyFirebaseIdToken(idToken, expectedEmployeeId) {
  if (!idToken) return false;
  const apiKey =
    process.env.FIREBASE_API_KEY ||
    process.env.VITE_FIREBASE_API_KEY;
  if (!apiKey) return false;
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.users) || data.users.length !== 1) return false;
  const expectedEmail = `${String(expectedEmployeeId || "").trim()}@ksph.gov.in`.toLowerCase();
  return String(data.users[0]?.email || "").trim().toLowerCase() === expectedEmail;
}

function rateLimit(map, key, options) {
  const now = Date.now();
  const windowMs = options.windowMs;
  const max = options.max;
  const existing = map.get(key);
  const current =
    existing && existing.windowStartedAt + windowMs > now
      ? existing
      : { count: 0, windowStartedAt: now };
  current.count += 1;
  map.set(key, current);
  if (current.count <= max) return { ok: true, retryAfterSeconds: 0 };
  return {
    ok: false,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((current.windowStartedAt + windowMs - now) / 1000),
    ),
  };
}

export function checkLoginRateLimit(clientKey, employeeId) {
  return rateLimit(
    loginAttempts,
    `${String(clientKey || "unknown")}:${String(employeeId || "").trim().toLowerCase()}`,
    {
      windowMs: positiveInteger(process.env.LOGIN_RATE_WINDOW_MS, 15 * 60 * 1000, 60_000, 86_400_000),
      max: positiveInteger(process.env.LOGIN_MAX_ATTEMPTS, 10, 3, 100),
    },
  );
}

export function clearLoginRateLimit(clientKey, employeeId) {
  loginAttempts.delete(
    `${String(clientKey || "unknown")}:${String(employeeId || "").trim().toLowerCase()}`,
  );
}

export function checkChatRateLimit(employeeId) {
  return rateLimit(chatRequests, String(employeeId || "").trim().toLowerCase(), {
    windowMs: positiveInteger(process.env.CHAT_RATE_WINDOW_MS, 60_000, 10_000, 3_600_000),
    max: positiveInteger(process.env.CHAT_MAX_REQUESTS, 20, 1, 200),
  });
}

export function checkSpeechRateLimit(employeeId) {
  return rateLimit(speechRequests, String(employeeId || "").trim().toLowerCase(), {
    windowMs: positiveInteger(process.env.STT_RATE_WINDOW_MS, 60_000, 10_000, 3_600_000),
    max: positiveInteger(process.env.STT_MAX_REQUESTS, 120, 20, 600),
  });
}

export function checkTtsRateLimit(employeeId) {
  return rateLimit(ttsRequests, String(employeeId || "").trim().toLowerCase(), {
    windowMs: positiveInteger(process.env.TTS_RATE_WINDOW_MS, 60_000, 10_000, 3_600_000),
    max: positiveInteger(process.env.TTS_MAX_REQUESTS, 30, 5, 300),
  });
}

export function sessionUser(session) {
  return {
    employeeId: session.employeeId,
    name: session.name,
    role: normalizeRole(session.role),
    policeStation: String(session.policeStation || ""),
    isFirstLogin: Boolean(session.isFirstLogin),
  };
}
