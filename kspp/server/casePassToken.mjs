import crypto from "node:crypto";

const DEFAULT_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const runtimeSecret = crypto.randomBytes(48);

function configuredSecret(override) {
  if (override) return Buffer.from(String(override));
  const configured = String(process.env.CASE_PASS_SECRET || process.env.SESSION_SECRET || "").trim();
  if (process.env.NODE_ENV === "production" && !configured) {
    throw new Error("CASE_PASS_SECRET or SESSION_SECRET is required in production.");
  }
  return configured ? Buffer.from(configured) : runtimeSecret;
}

function signature(encodedPayload, secret) {
  return crypto.createHmac("sha256", configuredSecret(secret)).update(encodedPayload).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createCasePassToken(caseId, options = {}) {
  const normalizedCaseId = String(caseId || "").trim();
  if (!normalizedCaseId) throw new Error("A case identifier is required.");
  const issuedAt = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const encodedPayload = Buffer.from(JSON.stringify({
    caseId: normalizedCaseId,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  })).toString("base64url");
  return `${encodedPayload}.${signature(encodedPayload, options.secret)}`;
}

export function verifyCasePassToken(token, options = {}) {
  const [encodedPayload, suppliedSignature, ...extra] = String(token || "").split(".");
  if (!encodedPayload || !suppliedSignature || extra.length) return null;
  if (!safeEqual(signature(encodedPayload, options.secret), suppliedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    if (!String(payload?.caseId || "").trim() || !Number.isFinite(payload?.expiresAt) || payload.expiresAt <= now) return null;
    return {
      caseId: String(payload.caseId).trim(),
      issuedAt: Number(payload.issuedAt) || 0,
      expiresAt: Number(payload.expiresAt),
    };
  } catch {
    return null;
  }
}
