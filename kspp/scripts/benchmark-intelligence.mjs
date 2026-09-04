import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildIntelligenceDataset } from "../src/lib/crimeIntelligence.ts";
import { trainHotspotModel } from "../src/lib/hotspotModel.ts";

const requested = Number.parseInt(process.env.KSPP_BENCHMARK_RECORDS || "1000000", 10);
const recordCount = Number.isFinite(requested) && requested > 0 ? requested : 1_000_000;
const firstDate = Date.UTC(2023, 0, 1);
const DAY_MS = 86_400_000;
const categories = ["Theft", "Fraud", "Assault", "Vehicle Theft"];

const startedAt = performance.now();
const records = new Array(recordCount);
for (let index = 0; index < recordCount; index += 1) {
  const latitudeCell = index % 300;
  const longitudeCell = Math.floor(index / 300) % 200;
  const latitude = 11.55 + latitudeCell * 0.023;
  const longitude = 74.05 + longitudeCell * 0.023;
  const occurredAt = firstDate + ((index * 17) % 1_150) * DAY_MS;
  const date = new Date(occurredAt).toISOString();
  const station = `Benchmark Station ${index % 500}`;
  const category = categories[index % categories.length];
  records[index] = {
    id: String(index),
    label: `Benchmark FIR ${index}`,
    fir: String(index),
    caseNo: String(index),
    category,
    station,
    io: "",
    status: "Under Investigation",
    gravity: index % 50 === 0 ? "Heinous" : "Non-Heinous",
    date,
    complainant: "",
    accused: "",
    victims: "",
    section: "",
    raw: {
      Latitude: latitude.toFixed(6),
      Longitude: longitude.toFixed(6),
      CrimeRegisteredDate: date,
      IncidentFromTime: `${String(index % 24).padStart(2, "0")}:00`,
      CrimeSubHead: category,
      PoliceStation: station,
      PlaceOfOccurrence: `Benchmark area ${latitudeCell}-${longitudeCell}`,
    },
  };
}
const generatedAt = performance.now();
const dataset = buildIntelligenceDataset(records, firstDate + 1_151 * DAY_MS);
const aggregatedAt = performance.now();
const training = trainHotspotModel(records);
const completedAt = performance.now();

assert.equal(dataset.totalRecords, recordCount);
assert.equal(dataset.geocodedRecords, recordCount);
assert.ok(dataset.hotspots.length <= 2500);
assert.ok(training.modelRecordsUsed <= 100_000);

const memory = process.memoryUsage();
console.log(JSON.stringify({
  syntheticRecords: recordCount,
  schemaOrSourceRowsModified: false,
  generatedSeconds: Number(((generatedAt - startedAt) / 1000).toFixed(2)),
  statewideAggregationSeconds: Number(((aggregatedAt - generatedAt) / 1000).toFixed(2)),
  boundedTrainingSeconds: Number(((completedAt - aggregatedAt) / 1000).toFixed(2)),
  totalSeconds: Number(((completedAt - startedAt) / 1000).toFixed(2)),
  geocodedRecords: dataset.geocodedRecords,
  aggregatedAreas: dataset.totalHotspotAreas,
  renderedAreas: dataset.hotspots.length,
  modelRecordsUsed: training.modelRecordsUsed,
  forecastStatus: training.status,
  balancedAccuracy: training.evaluation?.balancedAccuracy ?? null,
  precision: training.evaluation?.precision ?? null,
  recall: training.evaluation?.recall ?? null,
  peakHeapMb: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
}, null, 2));
