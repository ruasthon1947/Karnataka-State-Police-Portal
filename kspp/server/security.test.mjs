import assert from "node:assert/strict";
import test from "node:test";
import {
  canAccessCase,
  createSessionToken,
  filterCasesForSession,
  hashPassword,
  normalizeRole,
  readSession,
  verifyPassword,
} from "./security.mjs";

test("password hashes verify the new password without storing plaintext", async () => {
  const password = "Secure123";
  const encoded = await hashPassword(password);
  assert.match(encoded, /^scrypt\$/);
  assert.equal(encoded.includes(password), false);
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword("OldPassword1", encoded), false);
  await assert.rejects(() => hashPassword("short"), /at least 8/i);
  await assert.rejects(() => hashPassword("onlyletters"), /letter and one number/i);
});

test("role normalization uses a closed set", () => {
  assert.equal(normalizeRole("Superintendent of Police"), "SP");
  assert.equal(normalizeRole("Police Inspector"), "Inspector");
  assert.equal(normalizeRole("Unknown role"), "Constable");
});

test("constables only receive assigned or station cases while supervisors receive all", () => {
  const records = [
    {
      CaseMasterID: "1",
      PoliceStation: "Jayanagar Police Station",
      EmployeeID: "100",
      Officer: "Officer A",
    },
    {
      CaseMasterID: "2",
      PoliceStation: "Whitefield Police Station",
      EmployeeID: "200",
      Officer: "Officer B",
    },
  ];
  const constable = {
    employeeId: "emp-100",
    name: "Officer A",
    role: "Constable",
    policeStation: "Jayanagar PS",
  };
  assert.equal(canAccessCase(constable, records[0]), true);
  assert.equal(canAccessCase(constable, records[1]), false);
  assert.deepEqual(
    filterCasesForSession(constable, records).map((record) => record.CaseMasterID),
    ["1"],
  );
  assert.equal(
    filterCasesForSession({ ...constable, role: "Inspector" }, records).length,
    2,
  );
});

test("expired session tokens have a past expiry", () => {
  const session = createSessionToken(
    {
      employeeId: "emp-1",
      name: "Officer",
      role: "Constable",
      policeStation: "Central PS",
    },
    { expiresAt: Date.now() - 1 },
  );
  assert.equal(
    readSession({ headers: { cookie: `kspp_session=${session.token}` } }),
    null,
  );
});
