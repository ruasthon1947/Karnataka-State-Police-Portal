import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import localDbPlugin, { buildOptions, handleApi } from "./localDbPlugin.mjs";
import { mergeCaseTables } from "./googleSheets.mjs";
import { createSessionToken, setSessionCookie } from "./security.mjs";

async function withApiServer(run) {
  let middleware;
  localDbPlugin().configurePreviewServer({
    middlewares: {
      use(handler) {
        middleware = handler;
      },
    },
  });

  const server = http.createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404;
      response.end("fallback");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("map API endpoints pass through to the map middleware", async () => {
  for (const pathname of ["/api/geocode", "/api/place-suggestions", "/api/route"]) {
    let passedThrough = false;
    await handleApi(
      { method: "GET", url: pathname, headers: {}, socket: {} },
      {},
      () => { passedThrough = true; },
    );
    assert.equal(passedThrough, true, `${pathname} should reach the map middleware`);
  }
});

test("the primary API middleware owns OTP routes and blocks direct phone writes", async () => {
  await withApiServer(async (baseUrl) => {
    const protectedRequests = [
      ["POST", "/api/send-otp"],
      ["POST", "/api/verify-otp"],
      ["POST", "/api/phone"],
      ["GET", "/api/phone"],
      ["PUT", "/api/notification-preferences"],
      ["GET", "/api/cases"],
    ];
    for (const [method, pathname] of protectedRequests) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });
      assert.equal(response.status, 401);
      assert.match((await response.json()).error, /session has expired/i);
    }

    const session = createSessionToken({
      employeeId: "emp-100",
      name: "Test Officer",
      role: "Inspector",
      policeStation: "Jayanagar Police Station",
    });
    const directWriteResponse = await fetch(`${baseUrl}/api/phone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `kspp_session=${session.token}`,
      },
      body: JSON.stringify({
        employeeId: "emp-100",
        phoneNumber: "+919876543210",
      }),
    });
    assert.equal(directWriteResponse.status, 405);
    assert.deepEqual(await directWriteResponse.json(), {
      ok: false,
      error: "Phone numbers can only be saved after OTP verification.",
    });
  });
});

test("session endpoint rejects forged cookies and accepts signed cookies", async () => {
  await withApiServer(async (baseUrl) => {
    const forged = await fetch(`${baseUrl}/api/session`, {
      headers: { Cookie: "kspp_session=forged.value" },
    });
    assert.equal(forged.status, 401);

    const signed = createSessionToken({
      employeeId: "emp-200",
      name: "Inspector Rao",
      role: "Inspector",
      policeStation: "Central Police Station",
    });
    const valid = await fetch(`${baseUrl}/api/session`, {
      headers: { Cookie: `kspp_session=${signed.token}` },
    });
    assert.equal(valid.status, 200);
    const payload = await valid.json();
    assert.equal(payload.user.employeeId, "emp-200");
    assert.equal(payload.user.role, "Inspector");
    assert.equal(payload.user.policeStation, "Central Police Station");
  });
});

test("production session cookies remain persistent when a proxy omits its protocol header", () => {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorSessionSecret = process.env.SESSION_SECRET;
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "test-session-secret";
  try {
    let cookie = "";
    setSessionCookie(
      { headers: {}, socket: {} },
      { setHeader(name, value) { if (name === "Set-Cookie") cookie = value; } },
      { employeeId: "emp-300", name: "Inspector Khan", role: "Inspector" },
    );
    assert.match(cookie, /Max-Age=/);
    assert.doesNotMatch(cookie, /(?:^|; )Secure(?:;|$)/);
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (priorSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSessionSecret;
  }
});

test("case data includes historic CaseMaster rows and consolidated updates", () => {
  const merged = mergeCaseTables(
    { headers: ["CaseMasterID", "CrimeNo", "Status"], rows: [
      { CaseMasterID: "1", CrimeNo: "001/2026", Status: "Under Investigation" },
      { CaseMasterID: "2", CrimeNo: "002/2026", Status: "Closed" },
    ] },
    { headers: ["CaseMasterID", "CrimeNo", "Status", "Gravity"], rows: [
      { CaseMasterID: "1", CrimeNo: "001/2026", Status: "Charge Sheeted", Gravity: "Heinous" },
    ] },
  );
  assert.equal(merged.rows.length, 2);
  assert.deepEqual(merged.rows.find((row) => row.CaseMasterID === "1"), {
    CaseMasterID: "1", CrimeNo: "001/2026", Status: "Charge Sheeted", Gravity: "Heinous",
  });
  assert.ok(merged.headers.includes("Gravity"));
});

test("Google Sheet dropdown options are trimmed and deduplicated case-insensitively", () => {
  const options = buildOptions([
    {
      PoliceStation: " Jayanagar Police Station ",
      CrimeHead: "Theft",
      CrimeSubHead: "Chain Snatching",
      Acts: "BNS; IT Act",
    },
    {
      PoliceStation: "jayanagar police station",
      CrimeHead: " theft ",
      CrimeSubHead: " chain   snatching ",
      Acts: "bns; IT   Act",
    },
  ]);

  assert.deepEqual(options.PoliceStation, ["Jayanagar Police Station"]);
  assert.deepEqual(options.CrimeHead, ["Theft"]);
  assert.deepEqual(options.Acts, ["BNS", "IT Act"]);
  assert.deepEqual(options.crimeSubHeadsByHead, {
    Theft: ["Chain Snatching"],
  });
});
