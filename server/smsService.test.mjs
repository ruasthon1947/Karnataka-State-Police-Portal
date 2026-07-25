import assert from "node:assert/strict";
import test from "node:test";
import {
  SmsError,
  buildCaseAlertMessage,
  createCaseAlertService,
  createTwilioMessageSender,
  parseNotificationPreferences,
  serializeNotificationPreferences,
} from "./smsService.mjs";

test("the Twilio transport supports a Messaging Service and hides provider errors", async () => {
  let factoryArguments;
  let payload;
  const send = createTwilioMessageSender(
    {
      TWILIO_ACCOUNT_SID: "AC_test",
      TWILIO_AUTH_TOKEN: "token",
      TWILIO_MESSAGING_SERVICE_SID: "MG_test",
    },
    (...args) => {
      factoryArguments = args;
      return {
        messages: {
          create: async (message) => {
            payload = message;
            return { sid: "SM_test", status: "queued" };
          },
        },
      };
    },
  );

  assert.deepEqual(
    await send({ to: "98765 43210", body: " KSP   test alert " }),
    { id: "SM_test", status: "queued" },
  );
  assert.deepEqual(factoryArguments, [
    "AC_test",
    "token",
    { autoRetry: true, maxRetries: 2 },
  ]);
  assert.deepEqual(payload, {
    body: "KSP test alert",
    to: "+919876543210",
    messagingServiceSid: "MG_test",
  });

  const failing = createTwilioMessageSender(
    {
      TWILIO_ACCOUNT_SID: "AC_test",
      TWILIO_AUTH_TOKEN: "token",
      TWILIO_PHONE_NUMBER: "+12025550123",
    },
    () => ({
      messages: {
        create: async () => {
          throw Object.assign(new Error("provider detail"), { code: 30007, status: 400 });
        },
      },
    }),
  );
  await assert.rejects(
    failing({ to: "+919876543210", body: "Alert" }),
    (error) => error instanceof SmsError && error.code === "SMS_DELIVERY_FAILED",
  );
});

test("notification preferences round-trip and remain backward compatible", () => {
  assert.deepEqual(parseNotificationPreferences("true"), {
    newFir: true,
    statusUpdates: true,
  });
  assert.deepEqual(parseNotificationPreferences("false"), {
    newFir: false,
    statusUpdates: false,
  });
  assert.deepEqual(
    parseNotificationPreferences('{"newFir":false,"statusUpdates":true}'),
    { newFir: false, statusUpdates: true },
  );
  assert.equal(
    serializeNotificationPreferences({ newFir: true, statusUpdates: false }),
    '{"newFir":true,"statusUpdates":false}',
  );
});

test("new FIR alerts go only to verified, opted-in officers in the matching unit", async () => {
  const deliveries = [];
  const service = createCaseAlertService({
    alertsEnabled: true,
    sendMessage: async (message) => {
      deliveries.push(message);
    },
  });
  const result = await service.notify({
    event: "new_fir",
    record: {
      CrimeNo: "42/2026",
      PoliceStation: "Jayanagar Police Station",
      CrimeHead: "Theft",
    },
    units: [
      { UnitID: "10", UnitName: "Jayanagar PS" },
      { UnitID: "20", UnitName: "Indiranagar Police Station" },
    ],
    employees: [
      {
        EmployeeID: "100",
        UnitID: "10",
        PhoneNumber: "9876543210",
        PhoneVerifiedAt: "2026-07-25T10:00:00Z",
        NotificationPref: '{"newFir":true,"statusUpdates":false}',
      },
      {
        EmployeeID: "101",
        UnitID: "10",
        PhoneNumber: "9876543211",
        PhoneVerifiedAt: "",
        NotificationPref: "true",
      },
      {
        EmployeeID: "102",
        UnitID: "10",
        PhoneNumber: "9876543212",
        PhoneVerifiedAt: "2026-07-25T10:00:00Z",
        NotificationPref: "false",
      },
      {
        EmployeeID: "103",
        UnitID: "20",
        PhoneNumber: "9876543213",
        PhoneVerifiedAt: "2026-07-25T10:00:00Z",
        NotificationPref: "true",
      },
    ],
  });

  assert.equal(result.matched, 3);
  assert.equal(result.eligible, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.unverified, 1);
  assert.equal(result.disabled, 1);
  assert.deepEqual(deliveries, [
    {
      to: "+919876543210",
      body: "KSP FIR alert: 42/2026 was registered at Jayanagar Police Station. Type: Theft.",
    },
  ]);
});

test("status alerts route to the assigned officer and report delivery failures", async () => {
  const service = createCaseAlertService({
    alertsEnabled: true,
    sendMessage: async () => {
      throw new SmsError("failed", "SMS_DELIVERY_FAILED", 502);
    },
  });
  const record = {
    CrimeNo: "42/2026",
    EmployeeID: "100",
    Status: "Charge Sheeted",
  };
  const previousRecord = { Status: "Under Investigation" };
  const result = await service.notify({
    event: "status_update",
    record,
    previousRecord,
    employees: [
      {
        EmployeeID: "100",
        PhoneNumber: "9876543210",
        PhoneVerifiedAt: "TRUE",
        NotificationPref: '{"newFir":false,"statusUpdates":true}',
      },
      {
        EmployeeID: "101",
        PhoneNumber: "9876543211",
        PhoneVerifiedAt: "TRUE",
        NotificationPref: "true",
      },
    ],
  });

  assert.equal(result.matched, 1);
  assert.equal(result.eligible, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.errors, [
    { employeeId: "100", code: "SMS_DELIVERY_FAILED" },
  ]);
  assert.equal(
    buildCaseAlertMessage("status_update", record, previousRecord),
    "KSP case alert: 42/2026 status changed from Under Investigation to Charge Sheeted.",
  );
});
