import assert from "node:assert/strict";
import test from "node:test";
import { findMatchingCases } from "./geminiService.mjs";

test("finds zero-padded crime numbers from their normalized query form", () => {
  const records = [
    {
      CaseMasterID: "1221",
      CrimeNo: "0011/2026",
      CaseNo: "202601221",
      Complainant: "Harish Shetty",
      AccusedNames: "Gowri Rao; Deepa Hegde; Unknown",
    },
  ];
  assert.deepEqual(
    findMatchingCases("Who is the complainant and accused in case 11/2026?", records),
    records,
  );
});

test("does not match a shorter crime number inside a longer number", () => {
  const records = [
    { CaseMasterID: "1211", CrimeNo: "0001/2026" },
    { CaseMasterID: "1221", CrimeNo: "0011/2026" },
  ];
  assert.deepEqual(
    findMatchingCases("Who is the complainant and accused in case 0011/2026?", records),
    [records[1]],
  );
});
