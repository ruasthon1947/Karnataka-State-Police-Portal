import twilio from "twilio";

const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  newFir: true,
  statusUpdates: true,
});

function compact(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeText(value) {
  return compact(value)
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unitAliases(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  const simplified = normalized
    .replace(/\bpolice\b/g, " ")
    .replace(/\bstation\b/g, " ")
    .replace(/\bps\b/g, " ")
    .replace(/\bunit\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(new Set([normalized, simplified].filter(Boolean)));
}

function aliasesOverlap(left, right) {
  const leftAliases = unitAliases(left);
  const rightAliases = new Set(unitAliases(right));
  return leftAliases.some((alias) => rightAliases.has(alias));
}

function truthyFlag(value) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeText(value);
  return Boolean(normalized && !["false", "0", "no", "off"].includes(normalized));
}

function booleanValue(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = normalizeText(value);
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function maskPhoneNumber(phoneNumber) {
  return `${phoneNumber.slice(0, 3)}*****${phoneNumber.slice(-2)}`;
}

export class SmsError extends Error {
  constructor(message, code, status = 500, details = {}) {
    super(message);
    this.name = "SmsError";
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

export function normalizeIndianPhoneNumber(value) {
  const input = String(value ?? "").trim();
  if (!input) {
    throw new SmsError("Phone number is required.", "PHONE_REQUIRED", 400);
  }
  if (!/^[+()\d\s-]+$/.test(input)) {
    throw new SmsError(
      "Enter a valid Indian mobile number.",
      "PHONE_INVALID",
      400,
    );
  }

  let digits = input.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);

  if (!/^[6-9]\d{9}$/.test(digits)) {
    throw new SmsError(
      "Enter a valid 10-digit Indian mobile number.",
      "PHONE_INVALID",
      400,
    );
  }
  return `+91${digits}`;
}

export function getSmsProviderStatus(env = process.env) {
  const accountSid = compact(env.TWILIO_ACCOUNT_SID);
  const authToken = compact(env.TWILIO_AUTH_TOKEN);
  const from = compact(env.TWILIO_PHONE_NUMBER);
  const messagingServiceSid = compact(env.TWILIO_MESSAGING_SERVICE_SID);
  return {
    configured: Boolean(accountSid && authToken && (from || messagingServiceSid)),
    senderType: messagingServiceSid ? "messaging-service" : from ? "phone-number" : "none",
    alertsEnabled: normalizeText(env.SMS_ALERTS_ENABLED) !== "false",
  };
}

export function createTwilioMessageSender(env = process.env, clientFactory = twilio) {
  let client;
  let clientKey = "";

  return async ({ to: rawRecipient, body: rawBody }) => {
    const accountSid = compact(env.TWILIO_ACCOUNT_SID);
    const authToken = compact(env.TWILIO_AUTH_TOKEN);
    const from = compact(env.TWILIO_PHONE_NUMBER);
    const messagingServiceSid = compact(env.TWILIO_MESSAGING_SERVICE_SID);
    const to = normalizeIndianPhoneNumber(rawRecipient);
    const body = compact(rawBody);

    if (!body) {
      throw new SmsError("SMS content is required.", "SMS_BODY_REQUIRED", 400);
    }
    if (!accountSid || !authToken || (!from && !messagingServiceSid)) {
      throw new SmsError(
        "SMS delivery is temporarily unavailable.",
        "SMS_PROVIDER_NOT_CONFIGURED",
        503,
      );
    }

    const nextClientKey = `${accountSid}:${authToken}`;
    if (!client || clientKey !== nextClientKey) {
      client = clientFactory(accountSid, authToken, {
        autoRetry: true,
        maxRetries: 2,
      });
      clientKey = nextClientKey;
    }

    const message = { body, to };
    if (messagingServiceSid) message.messagingServiceSid = messagingServiceSid;
    else message.from = from;

    try {
      const result = await client.messages.create(message);
      return {
        id: compact(result?.sid),
        status: compact(result?.status) || "accepted",
      };
    } catch (error) {
      console.error("[SMS] Twilio delivery failed", {
        code: error?.code,
        status: error?.status,
        recipient: maskPhoneNumber(to),
      });
      throw new SmsError(
        "We couldn't deliver the SMS. Check the number and try again.",
        "SMS_DELIVERY_FAILED",
        502,
      );
    }
  };
}

export function parseNotificationPreferences(value) {
  if (value == null || value === "") return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  if (typeof value === "boolean" || typeof value === "number") {
    const enabled = booleanValue(value, true);
    return { newFir: enabled, statusUpdates: enabled };
  }

  if (typeof value === "string") {
    const normalized = normalizeText(value);
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return { newFir: true, statusUpdates: true };
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return { newFir: false, statusUpdates: false };
    }
    try {
      return parseNotificationPreferences(JSON.parse(value));
    } catch {
      return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    }
  }

  if (typeof value === "object") {
    return {
      newFir: booleanValue(
        value.newFir ?? value.new_fir ?? value.fir,
        DEFAULT_NOTIFICATION_PREFERENCES.newFir,
      ),
      statusUpdates: booleanValue(
        value.statusUpdates ?? value.status_updates ?? value.status,
        DEFAULT_NOTIFICATION_PREFERENCES.statusUpdates,
      ),
    };
  }
  return { ...DEFAULT_NOTIFICATION_PREFERENCES };
}

export function serializeNotificationPreferences(value) {
  return JSON.stringify(parseNotificationPreferences(value));
}

export function buildCaseAlertMessage(event, record, previousRecord = {}) {
  if (event === "patrol_alert") {
    const station = compact(record.PoliceStation || record.Station) || "the assigned station";
    const zone = compact(record.ZoneName || record.Location) || station;
    const score = Number.isFinite(Number(record.RiskPercentage))
      ? ` Score: ${Math.round(Number(record.RiskPercentage))}%.`
      : "";
    const mode = compact(record.RiskMode) || "crime intelligence";
    const peak = compact(record.PeakWindow);
    const peakText = peak && peak !== "Not recorded" ? ` Peak window: ${peak}.` : "";
    return `KSP patrol alert: deploy visible patrol near ${zone}, ${station}. ${mode}.${score}${peakText}`;
  }
  const reference = compact(record.CrimeNo || record.CaseNo || record.CaseMasterID) || "Unnumbered case";
  if (event === "status_update") {
    const fromStatus = compact(previousRecord.Status) || "Not set";
    const toStatus = compact(record.Status) || "Not set";
    return `KSP case alert: ${reference} status changed from ${fromStatus} to ${toStatus}.`;
  }

  const station = compact(record.PoliceStation || record.Station) || "the assigned unit";
  const crimeType = compact(record.CrimeSubHead || record.CrimeHead || record.CaseCategory);
  const suffix = crimeType ? ` Type: ${crimeType}.` : "";
  return `KSP FIR alert: ${reference} was registered at ${station}.${suffix}`;
}

function employeeMatchesNewFir(employee, station, units) {
  const matchingUnitIds = new Set(
    units
      .filter((unit) =>
        [unit.UnitName, unit.PoliceStation, unit.Station, unit.UnitID].some((value) =>
          aliasesOverlap(value, station),
        ),
      )
      .map((unit) => normalizeText(unit.UnitID))
      .filter(Boolean),
  );

  const employeeUnitId = normalizeText(employee.UnitID);
  if (employeeUnitId && matchingUnitIds.has(employeeUnitId)) return true;
  return [employee.UnitName, employee.PoliceStation, employee.Station].some((value) =>
    aliasesOverlap(value, station),
  );
}

function employeeMatchesStatusUpdate(employee, record) {
  const assignedId = normalizeText(record.EmployeeID);
  const employeeIds = [employee.EmployeeID, employee.KGID].map(normalizeText).filter(Boolean);
  if (assignedId && employeeIds.includes(assignedId)) return true;

  const assignedOfficer = normalizeText(record.Officer);
  const employeeNames = [employee.Name, employee.FirstName]
    .map(normalizeText)
    .filter(Boolean);
  return Boolean(assignedOfficer && employeeNames.includes(assignedOfficer));
}

export function createCaseAlertService(options = {}) {
  const sendMessage = options.sendMessage ?? createTwilioMessageSender();
  const alertsEnabled =
    options.alertsEnabled ??
    (normalizeText(process.env.SMS_ALERTS_ENABLED) !== "false");

  return {
    async notify({ event, record, previousRecord = {}, employees = [], units = [] }) {
      const summary = {
        event,
        matched: 0,
        eligible: 0,
        sent: 0,
        failed: 0,
        disabled: 0,
        unverified: 0,
        invalidPhone: 0,
        duplicate: 0,
        providerConfigured: getSmsProviderStatus().configured,
        errors: [],
      };
      if (!alertsEnabled || !["new_fir", "status_update", "patrol_alert"].includes(event)) {
        return summary;
      }

      const station = compact(record.PoliceStation || record.Station);
      const matchedEmployees = employees.filter((employee) =>
        event === "status_update"
          ? employeeMatchesStatusUpdate(employee, record)
          : employeeMatchesNewFir(employee, station, units),
      );
      summary.matched = matchedEmployees.length;

      const recipients = [];
      const seenPhones = new Set();
      for (const employee of matchedEmployees) {
        const preferences = parseNotificationPreferences(employee.NotificationPref);
        const optedIn = event === "status_update" ? preferences.statusUpdates : preferences.newFir;
        if (!optedIn) {
          summary.disabled += 1;
          continue;
        }
        if (!employee.PhoneNumber || !truthyFlag(employee.PhoneVerifiedAt)) {
          summary.unverified += 1;
          continue;
        }

        let phoneNumber;
        try {
          phoneNumber = normalizeIndianPhoneNumber(employee.PhoneNumber);
        } catch {
          summary.invalidPhone += 1;
          continue;
        }
        if (seenPhones.has(phoneNumber)) {
          summary.duplicate += 1;
          continue;
        }
        seenPhones.add(phoneNumber);
        recipients.push({ employee, phoneNumber });
      }

      summary.eligible = recipients.length;
      const body = buildCaseAlertMessage(event, record, previousRecord);
      const results = await Promise.all(
        recipients.map(async ({ employee, phoneNumber }) => {
          try {
            await sendMessage({ to: phoneNumber, body });
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              employeeId: compact(employee.EmployeeID || employee.KGID),
              code: compact(error?.code) || "SMS_DELIVERY_FAILED",
            };
          }
        }),
      );

      for (const result of results) {
        if (result.ok) summary.sent += 1;
        else {
          summary.failed += 1;
          summary.errors.push({
            employeeId: result.employeeId,
            code: result.code,
          });
        }
      }
      return summary;
    },
  };
}

export const caseAlertService = createCaseAlertService();
