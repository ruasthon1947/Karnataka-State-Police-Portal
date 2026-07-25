import assert from "node:assert/strict";
import test from "node:test";
import {
  OtpError,
  createOtpService,
  createTwilioSmsSender,
  normalizeIndianPhoneNumber,
} from "./otpService.mjs";

function hasCode(code) {
  return (error) => {
    assert.ok(error instanceof OtpError);
    assert.equal(error.code, code);
    return true;
  };
}

test("normalizes supported Indian mobile formats and rejects invalid numbers", () => {
  assert.equal(normalizeIndianPhoneNumber("98765 43210"), "+919876543210");
  assert.equal(normalizeIndianPhoneNumber("+91-98765-43210"), "+919876543210");
  assert.equal(normalizeIndianPhoneNumber("09876543210"), "+919876543210");
  assert.throws(
    () => normalizeIndianPhoneNumber("+91 12345 67890"),
    hasCode("PHONE_INVALID"),
  );
  assert.throws(
    () => normalizeIndianPhoneNumber("98765abc210"),
    hasCode("PHONE_INVALID"),
  );
});

test("builds a Twilio message without exposing provider errors to the caller", async () => {
  let factoryArguments;
  let message;
  const sender = createTwilioSmsSender(
    {
      TWILIO_ACCOUNT_SID: "AC_test",
      TWILIO_AUTH_TOKEN: "token",
      TWILIO_MESSAGING_SERVICE_SID: "MG_test",
    },
    (...args) => {
      factoryArguments = args;
      return {
        messages: {
          create: async (payload) => {
            message = payload;
          },
        },
      };
    },
  );

  await sender({
    to: "+919876543210",
    code: "123456",
    expiresInMinutes: 5,
  });
  assert.deepEqual(factoryArguments, [
    "AC_test",
    "token",
    { autoRetry: true, maxRetries: 2 },
  ]);
  assert.deepEqual(message, {
    body: "123456 is your KSP Portal verification code. It expires in 5 minutes. Do not share it.",
    to: "+919876543210",
    messagingServiceSid: "MG_test",
  });

  const unconfiguredSender = createTwilioSmsSender({}, () => {
    throw new Error("The Twilio client should not be created.");
  });
  await assert.rejects(
    unconfiguredSender({
      to: "+919876543210",
      code: "123456",
      expiresInMinutes: 5,
    }),
    hasCode("OTP_PROVIDER_NOT_CONFIGURED"),
  );
});

test("sends a six-digit OTP, checks the employee binding, and consumes it after save", async () => {
  let currentTime = 1_000;
  let delivered;
  let saved;
  const service = createOtpService({
    now: () => currentTime,
    generateCode: () => "042019",
    sendCode: async (message) => {
      delivered = message;
    },
    hashSecret: "test-secret",
    expiryMs: 300_000,
    resendCooldownMs: 60_000,
  });

  const request = await service.request({
    subject: " EMP-100 ",
    phoneNumber: "9876543210",
    clientKey: "test-client",
  });

  assert.equal(delivered.to, "+919876543210");
  assert.equal(delivered.code, "042019");
  assert.equal(request.expiresInSeconds, 300);
  assert.equal(request.retryAfterSeconds, 60);

  await assert.rejects(
    service.verifyAndRun(
      {
        subject: "EMP-101",
        phoneNumber: "+919876543210",
        code: "042019",
      },
      async () => {},
    ),
    hasCode("OTP_NOT_FOUND"),
  );

  const result = await service.verifyAndRun(
    {
      subject: "emp-100",
      phoneNumber: "+919876543210",
      code: "042019",
    },
    async (verified) => {
      saved = verified;
    },
  );

  assert.deepEqual(saved, {
    subject: "emp-100",
    phoneNumber: "+919876543210",
  });
  assert.equal(result.phoneNumber, "+919876543210");
  await assert.rejects(
    service.verifyAndRun(
      {
        subject: "emp-100",
        phoneNumber: "+919876543210",
        code: "042019",
      },
      async () => {},
    ),
    hasCode("OTP_NOT_FOUND"),
  );
});

test("enforces resend cooldown, expiry, and incorrect-attempt limits", async () => {
  let currentTime = 5_000;
  const service = createOtpService({
    now: () => currentTime,
    generateCode: () => "123456",
    sendCode: async () => {},
    hashSecret: "test-secret",
    expiryMs: 5_000,
    resendCooldownMs: 1_000,
    maxVerifyAttempts: 2,
  });

  const payload = {
    subject: "emp-200",
    phoneNumber: "+919876543211",
    clientKey: "test-client",
  };
  await service.request(payload);

  await assert.rejects(
    service.request(payload),
    hasCode("OTP_RESEND_COOLDOWN"),
  );
  await assert.rejects(
    service.verifyAndRun(
      { ...payload, code: "000000" },
      async () => {},
    ),
    hasCode("OTP_INCORRECT"),
  );
  await assert.rejects(
    service.verifyAndRun(
      { ...payload, code: "000000" },
      async () => {},
    ),
    hasCode("OTP_ATTEMPTS_EXHAUSTED"),
  );

  currentTime += 1_001;
  await service.request(payload);
  currentTime += 5_000;
  await assert.rejects(
    service.verifyAndRun(
      { ...payload, code: "123456" },
      async () => {},
    ),
    hasCode("OTP_EXPIRED"),
  );
});

test("keeps a valid OTP retryable when persistence fails", async () => {
  const service = createOtpService({
    generateCode: () => "654321",
    sendCode: async () => {},
    hashSecret: "test-secret",
  });
  const payload = {
    subject: "emp-300",
    phoneNumber: "+919876543212",
    clientKey: "test-client",
  };
  await service.request(payload);

  await assert.rejects(
    service.verifyAndRun(
      { ...payload, code: "654321" },
      async () => {
        throw new OtpError("Save failed.", "PHONE_SAVE_FAILED", 502);
      },
    ),
    hasCode("PHONE_SAVE_FAILED"),
  );

  let saved = false;
  await service.verifyAndRun(
    { ...payload, code: "654321" },
    async () => {
      saved = true;
    },
  );
  assert.equal(saved, true);
});

test("does not replace the current challenge when a resend cannot be delivered", async () => {
  let currentTime = 0;
  let nextCode = "111111";
  let failDelivery = false;
  const service = createOtpService({
    now: () => currentTime,
    generateCode: () => nextCode,
    sendCode: async () => {
      if (failDelivery) {
        throw new OtpError("Delivery failed.", "OTP_DELIVERY_FAILED", 502);
      }
    },
    hashSecret: "test-secret",
    expiryMs: 10_000,
    resendCooldownMs: 1_000,
  });
  const payload = {
    subject: "emp-400",
    phoneNumber: "+919876543213",
    clientKey: "test-client",
  };
  await service.request(payload);

  currentTime = 1_001;
  nextCode = "222222";
  failDelivery = true;
  await assert.rejects(
    service.request(payload),
    hasCode("OTP_DELIVERY_FAILED"),
  );

  let saved = false;
  await service.verifyAndRun(
    { ...payload, code: "111111" },
    async () => {
      saved = true;
    },
  );
  assert.equal(saved, true);
});
