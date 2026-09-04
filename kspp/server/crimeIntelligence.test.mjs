import assert from "node:assert/strict";
import test from "node:test";
import { buildIntelligenceDataset } from "../src/lib/crimeIntelligence.ts";

const DAY_MS = 86_400_000;

function fir(id, latitude, longitude, station = "Karnataka Police Station") {
  const date = new Date(Date.UTC(2026, 7, 1) + (Number(id) % 20) * DAY_MS).toISOString();
  return {
    id: String(id),
    label: `FIR ${id}`,
    fir: String(id),
    caseNo: String(id),
    category: "Theft",
    station,
    io: "",
    status: "Under Investigation",
    gravity: "Non-Heinous",
    date,
    complainant: "",
    accused: "",
    victims: "",
    section: "",
    raw: {
      Latitude: String(latitude),
      Longitude: String(longitude),
      CrimeRegisteredDate: date,
      CrimeSubHead: "Theft",
      PoliceStation: station,
      PlaceOfOccurrence: station,
    },
  };
}

test("accepts geocoded FIRs across Karnataka and rejects coordinates outside the state guard", () => {
  const records = [
    fir(1, 12.2958, 76.6394, "Mysuru Police Station"),
    fir(2, 15.8497, 74.4977, "Belagavi Police Station"),
    fir(3, 19.076, 72.8777, "Outside Karnataka"),
  ];
  const result = buildIntelligenceDataset(records, Date.UTC(2026, 8, 1));
  assert.equal(result.totalRecords, 3);
  assert.equal(result.geocodedRecords, 2);
  assert.equal(result.totalHotspotAreas, 2);
  assert.equal(result.hotspots.length, 2);
});

test("bounds the rendered statewide patrol areas without dropping analysed FIR counts", () => {
  const records = Array.from({ length: 2601 }, (_, index) => {
    const row = Math.floor(index / 51);
    const column = index % 51;
    return fir(index, 12 + row * 0.04, 74.2 + column * 0.04);
  });
  const result = buildIntelligenceDataset(records, Date.UTC(2026, 8, 1));
  assert.equal(result.geocodedRecords, records.length);
  assert.equal(result.totalHotspotAreas, records.length);
  assert.equal(result.hotspots.length, 2500);
});
