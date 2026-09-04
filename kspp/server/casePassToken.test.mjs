import assert from "node:assert/strict";
import test from "node:test";
import { createCasePassToken, verifyCasePassToken } from "./casePassToken.mjs";

test("creates a signed expiring case pass without exposing a reusable plain identifier", () => {
  const token = createCasePassToken("202601235", { secret: "test-secret", now: 1000, ttlMs: 5000 });
  assert.equal(token.split(".").length, 2);
  assert.deepEqual(verifyCasePassToken(token, { secret: "test-secret", now: 2000 }), {
    caseId: "202601235",
    issuedAt: 1000,
    expiresAt: 6000,
  });
});

test("rejects tampered, wrongly signed, and expired case passes", () => {
  const token = createCasePassToken("202601235", { secret: "test-secret", now: 1000, ttlMs: 5000 });
  assert.equal(verifyCasePassToken(`${token}x`, { secret: "test-secret", now: 2000 }), null);
  assert.equal(verifyCasePassToken(token, { secret: "other-secret", now: 2000 }), null);
  assert.equal(verifyCasePassToken(token, { secret: "test-secret", now: 6000 }), null);
});
