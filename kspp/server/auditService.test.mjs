import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuditService } from "./auditService.mjs";

const session = {
  employeeId: "KSP-1042",
  name: "Test Officer",
  role: "Constable",
  policeStation: "Central Police Station",
};

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kspp-audit-"));
  const localPath = path.join(directory, "events.jsonl");
  const service = createAuditService({
    localPath,
    secret: "test-audit-secret-that-is-long-and-stable",
    useRemote: false,
    sheetId: "",
  });
  return { directory, localPath, service };
}

test("audit events preserve server actor context and verify integrity seals", async (t) => {
  const { directory, service } = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await service.record({
    session,
    action: "SEARCH",
    targetType: "FIR_RECORDS",
    targetId: "Advanced Search",
    details: { query: "0020/2026", matchingCases: 1 },
  });
  await service.record({
    session,
    action: "RECORD_ACCESS",
    targetType: "FIR",
    targetId: "0020/2026",
  });

  const result = await service.list();
  assert.equal(result.total, 2);
  assert.equal(result.integrity.verified, true);
  assert.equal(result.integrity.checked, 2);
  assert.equal(result.events[0].OfficerID, session.employeeId);
  assert.equal(result.events[0].Role, session.role);
  assert.equal(result.events[0].PoliceStation, session.policeStation);
  assert.equal(result.events[0].TargetID, "0020/2026");
  assert.equal(result.storage.mode, "Local write-ahead log");
});

test("audit filters work and a modified record fails verification", async (t) => {
  const { directory, localPath, service } = await fixture();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await service.record({ session, action: "FIR_UPDATED", targetType: "FIR", targetId: "A-1" });
  await service.record({ session, action: "SMS_PATROL_ALERT", targetType: "POLICE_STATION", targetId: "Central" });

  const filtered = await service.list({ action: "SMS_PATROL_ALERT", query: "central" });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.events[0].Action, "SMS_PATROL_ALERT");

  const lines = (await fs.readFile(localPath, "utf8")).trim().split(/\r?\n/);
  const modified = JSON.parse(lines[0]);
  modified.TargetID = "CHANGED";
  lines[0] = JSON.stringify(modified);
  await fs.writeFile(localPath, `${lines.join("\n")}\n`, "utf8");

  const checked = await service.list();
  assert.equal(checked.integrity.verified, false);
  assert.deepEqual(checked.integrity.brokenEventIds, [modified.EventID]);
});
