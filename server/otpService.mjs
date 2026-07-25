import crypto from "node:crypto";
import {
  SmsError,
  createTwilioMessageSender,
  normalizeIndianPhoneNumber as normalizeSmsPhoneNumber,
} from "./smsService.mjs";

const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;
const DEFAULT_RESEND_COOLDOWN_MS = 60 * 1000;
const DEFAULT_RATE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SENDS_PER_WINDOW = 5;
const DEFAULT_MAX_VERIFY_ATTEMPTS = 5;

function positiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function secondsRemaining(milliseconds) {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

function normalizeSubject(value) {
  const subject = String(value ?? "").trim().toLowerCase();
  if (!subject) {
    throw new OtpError("Employee ID is required.", "EMPLOYEE_ID_REQUIRED", 400);
  }
  return subject;
}

function safeCode(value) {
  const code = String(value ?? "").trim();
  if (!/^\d{6}$/.test(code)) {
    throw new OtpError("Enter the 6-digit OTP.", "OTP_INVALID_FORMAT", 400);
  }
  return code;
}

function maskPhoneNumber(phoneNumber) {
  return `${phoneNumber.slice(0, 3)}•••••${phoneNumber.slice(-2)}`;
}

export class OtpError extends Error {
  constructor(message, code, status = 400, details = {}) {
    super(message);
    this.name = "OtpError";
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

export function normalizeIndianPhoneNumber(value) {
  try {
    return normalizeSmsPhoneNumber(value);
  } catch (error) {
    if (error instanceof SmsError) {
      throw new OtpError(error.message, error.code, error.status);
    }
    throw error;
  }
}

export function createTwilioSmsSender(env = process.env, clientFactory) {
  const sendMessage = createTwilioMessageSender(env, clientFactory);
  return async ({ to, code, expiresInMinutes }) => {
    try {
      return await sendMessage({
        body: `${code} is your KSP Portal verification code. It expires in ${expiresInMinutes} minutes. Do not share it.`,
        to,
      });
    } catch (error) {
      if (error instanceof SmsError) {
        const mappedCode =
          error.code === "SMS_PROVIDER_NOT_CONFIGURED"
            ? "OTP_PROVIDER_NOT_CONFIGURED"
            : error.code === "PHONE_INVALID"
              ? "PHONE_INVALID"
              : "OTP_DELIVERY_FAILED";
        const message =
          mappedCode === "OTP_PROVIDER_NOT_CONFIGURED"
            ? "SMS verification is temporarily unavailable."
            : mappedCode === "PHONE_INVALID"
              ? error.message
              : "We couldn't send the OTP. Check the number and try again.";
        throw new OtpError(message, mappedCode, error.status);
      }
      throw new OtpError(
        "We couldn't send the OTP. Check the number and try again.",
        "OTP_DELIVERY_FAILED",
        502,
      );
    }
  };
}

export function createOtpService(options = {}) {
  const now = options.now ?? Date.now;
  const generateCode =
    options.generateCode ??
    (() => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0"));
  const sendCode = options.sendCode ?? createTwilioSmsSender();
  const expiryMs = positiveInteger(
    options.expiryMs ?? process.env.OTP_EXPIRY_MS,
    DEFAULT_EXPIRY_MS,
    1_000,
  );
  const resendCooldownMs = positiveInteger(
    options.resendCooldownMs ?? process.env.OTP_RESEND_COOLDOWN_MS,
    DEFAULT_RESEND_COOLDOWN_MS,
    1_000,
  );
  const rateWindowMs = positiveInteger(
    options.rateWindowMs ?? process.env.OTP_RATE_WINDOW_MS,
    DEFAULT_RATE_WINDOW_MS,
    1_000,
  );
  const maxSendsPerWindow = positiveInteger(
    options.maxSendsPerWindow ?? process.env.OTP_MAX_SENDS_PER_WINDOW,
    DEFAULT_MAX_SENDS_PER_WINDOW,
    1,
    20,
  );
  const maxVerifyAttempts = positiveInteger(
    options.maxVerifyAttempts ?? process.env.OTP_MAX_VERIFY_ATTEMPTS,
    DEFAULT_MAX_VERIFY_ATTEMPTS,
    1,
    10,
  );
  const hashSecret = Buffer.from(
    String(
      options.hashSecret ??
        process.env.OTP_HASH_SECRET ??
        process.env.TWILIO_AUTH_TOKEN ??
        crypto.randomBytes(32).toString("hex"),
    ),
  );

  const challenges = new Map();
  const sendEvents = new Map();

  const challengeKey = (subject, phoneNumber) => `${subject}:${phoneNumber}`;
  const digest = (key, code) =>
    crypto.createHmac("sha256", hashSecret).update(`${key}:${code}`).digest();

  function prune(currentTime, activeChallengeKey = "") {
    for (const [key, challenge] of challenges) {
      if (key !== activeChallengeKey && currentTime >= challenge.expiresAt) {
        challenges.delete(key);
      }
    }
    for (const key of sendEvents.keys()) {
      cleanEvents(key, currentTime);
    }
  }

  function cleanEvents(key, currentTime) {
    const recent = (sendEvents.get(key) ?? []).filter(
      (eventTime) => currentTime - eventTime < rateWindowMs,
    );
    if (recent.length) sendEvents.set(key, recent);
    else sendEvents.delete(key);
    return recent;
  }

  function checkRateLimit(key, currentTime) {
    const recent = cleanEvents(key, currentTime);
    if (recent.length >= maxSendsPerWindow) {
      const retryAfterMs = rateWindowMs - (currentTime - recent[0]);
      throw new OtpError(
        `Too many OTP requests. Try again in ${secondsRemaining(retryAfterMs)} seconds.`,
        "OTP_RATE_LIMITED",
        429,
        { retryAfterSeconds: secondsRemaining(retryAfterMs) },
      );
    }
  }

  function recordSendEvent(key, currentTime) {
    const recent = cleanEvents(key, currentTime);
    recent.push(currentTime);
    sendEvents.set(key, recent);
  }

  async function request({ subject: subjectValue, phoneNumber: phoneValue, clientKey = "unknown" }) {
    const subject = normalizeSubject(subjectValue);
    const phoneNumber = normalizeIndianPhoneNumber(phoneValue);
    const key = challengeKey(subject, phoneNumber);
    const currentTime = now();
    prune(currentTime, key);
    const existing = challenges.get(key);

    if (existing && currentTime < existing.sentAt + resendCooldownMs) {
      const retryAfterMs = existing.sentAt + resendCooldownMs - currentTime;
      throw new OtpError(
        `Please wait ${secondsRemaining(retryAfterMs)} seconds before requesting another OTP.`,
        "OTP_RESEND_COOLDOWN",
        429,
        { retryAfterSeconds: secondsRemaining(retryAfterMs) },
      );
    }

    const rateLimitKeys = [
      `phone:${phoneNumber}`,
      `client:${String(clientKey).trim() || "unknown"}`,
    ];
    rateLimitKeys.forEach((rateKey) => checkRateLimit(rateKey, currentTime));

    const code = safeCode(generateCode());
    await sendCode({
      to: phoneNumber,
      code,
      expiresInMinutes: Math.ceil(expiryMs / 60_000),
    });
    rateLimitKeys.forEach((rateKey) => recordSendEvent(rateKey, currentTime));

    challenges.set(key, {
      codeDigest: digest(key, code),
      expiresAt: currentTime + expiryMs,
      sentAt: currentTime,
      attemptsRemaining: maxVerifyAttempts,
      pending: false,
    });

    return {
      phoneNumber,
      expiresInSeconds: secondsRemaining(expiryMs),
      retryAfterSeconds: secondsRemaining(resendCooldownMs),
    };
  }

  async function verifyAndRun(
    { subject: subjectValue, phoneNumber: phoneValue, code: codeValue },
    onVerified,
  ) {
    const subject = normalizeSubject(subjectValue);
    const phoneNumber = normalizeIndianPhoneNumber(phoneValue);
    const code = safeCode(codeValue);
    const key = challengeKey(subject, phoneNumber);
    const currentTime = now();
    prune(currentTime, key);
    const challenge = challenges.get(key);

    if (!challenge) {
      throw new OtpError(
        "Request a new OTP before verifying.",
        "OTP_NOT_FOUND",
        400,
      );
    }
    if (currentTime >= challenge.expiresAt) {
      challenges.delete(key);
      throw new OtpError(
        "The OTP has expired. Request a new one.",
        "OTP_EXPIRED",
        410,
      );
    }
    if (challenge.pending) {
      throw new OtpError(
        "This OTP is already being verified. Please wait.",
        "OTP_VERIFICATION_IN_PROGRESS",
        409,
      );
    }

    const suppliedDigest = digest(key, code);
    if (
      suppliedDigest.length !== challenge.codeDigest.length ||
      !crypto.timingSafeEqual(suppliedDigest, challenge.codeDigest)
    ) {
      challenge.attemptsRemaining -= 1;
      if (challenge.attemptsRemaining <= 0) {
        challenges.delete(key);
        throw new OtpError(
          "Too many incorrect attempts. Request a new OTP.",
          "OTP_ATTEMPTS_EXHAUSTED",
          429,
          { attemptsRemaining: 0 },
        );
      }
      throw new OtpError(
        `Incorrect OTP. ${challenge.attemptsRemaining} attempt${challenge.attemptsRemaining === 1 ? "" : "s"} remaining.`,
        "OTP_INCORRECT",
        400,
        { attemptsRemaining: challenge.attemptsRemaining },
      );
    }

    challenge.pending = true;
    try {
      await onVerified({ subject, phoneNumber });
      challenges.delete(key);
      return { phoneNumber };
    } catch (error) {
      challenge.pending = false;
      throw error;
    }
  }

  return {
    request,
    verifyAndRun,
  };
}

export const otpService = createOtpService();
