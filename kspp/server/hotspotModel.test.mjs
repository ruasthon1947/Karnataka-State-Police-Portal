import assert from "node:assert/strict";
import test from "node:test";
import {
  predictHotspotForecast,
  predictHotspotRisk,
  trainHotspotModel,
} from "../src/lib/hotspotModel.ts";

function historicalFirRecords() {
  const start = Date.UTC(2025, 0, 1);
  const records = [];
  for (let day = 0; day < 150; day += 1) {
    const add = (latitude, longitude, hour, category) => {
      const date = new Date(start + (day * 86_400_000)).toISOString();
      records.push({
        id: String(records.length),
        date,
        category,
        gravity: day % 19 === 0 ? "Heinous" : "",
        raw: {
          Latitude: String(latitude),
          Longitude: String(longitude),
          CrimeRegisteredDate: date,
          IncidentFromTime: `${String(hour).padStart(2, "0")}:00`,
          CrimeSubHead: category,
        },
      });
    };
    if (day % 2 === 0) add(12.97, 77.59, 20, "Theft");
    if (day % 5 === 0) add(12.94, 77.62, 12, "Fraud");
    if (day % 9 === 0) add(13.02, 77.66, 4, "Assault");
    if (day > 70 && day % 3 === 0) add(12.88, 77.70, 20, "Vehicle Theft");
  }
  return records;
}

test("refuses to publish a neural forecast without enough dated geocoded history", () => {
  const result = trainHotspotModel([]);
  assert.equal(result.model, null);
  assert.equal(result.evaluation, null);
  assert.equal(result.status, "insufficient_data");
  assert.match(result.reason, /60 dated, geocoded FIRs/);
});

test("trains versioned weights and validates against later chronological windows", () => {
  const result = trainHotspotModel(historicalFirRecords());
  assert.equal(result.reason, "");
  assert.equal(result.status, "validated");
  assert.ok(result.model);
  assert.equal(result.evaluation, result.model.metrics);
  assert.equal(result.model.version, "1.3");
  assert.ok(result.model.metrics.trainingSamples > result.model.metrics.validationSamples);
  assert.ok(result.model.metrics.validationPositives > 0);
  assert.ok(result.model.metrics.trainingThrough < result.model.metrics.validationFrom);
  assert.ok(result.model.metrics.validationThrough <= result.model.dataThrough);
  assert.ok(result.model.metrics.balancedAccuracy >= 55);
  assert.ok(result.model.metrics.balancedAccuracy > result.model.metrics.baselineBalancedAccuracy);
  assert.ok(result.model.metrics.accuracyUplift > 0);
  assert.ok(result.model.metrics.balancedAccuracyLow <= result.model.metrics.balancedAccuracy);
  assert.ok(result.model.metrics.balancedAccuracyHigh >= result.model.metrics.balancedAccuracy);
  assert.ok(result.model.metrics.brierScore <= 0.35);
  assert.ok(result.model.metrics.brierScore <= result.model.metrics.baselineBrierScore);
  assert.ok(result.model.metrics.baselineBrierScore >= 0 && result.model.metrics.baselineBrierScore <= 1);
  assert.ok(result.model.metrics.backtestWindows > 0);
  assert.ok(result.model.metrics.uncertaintyMargin >= 0 && result.model.metrics.uncertaintyMargin <= 100);
  assert.ok(result.model.hiddenWeights.flat().every(Number.isFinite));

  const score = predictHotspotRisk(result.model, {
    liveRisk: 78,
    recentCases: 11,
    trend: 35,
    category: "Vehicle Theft",
    hour: 20,
    horizonDays: 7,
  });
  assert.ok(Number.isInteger(score));
  assert.ok(score >= 0 && score <= 100);

  const forecast = predictHotspotForecast(result.model, {
    liveRisk: 78,
    recentCases: 11,
    trend: 35,
    category: "Vehicle Theft",
    hour: 20,
    horizonDays: 7,
  });
  assert.equal(forecast.risk, score);
  assert.ok(forecast.lowerBound >= 0 && forecast.lowerBound <= forecast.risk);
  assert.ok(forecast.upperBound <= 100 && forecast.upperBound >= forecast.risk);
  assert.equal(forecast.factors.length, 3);
  assert.ok(forecast.factors.every((factor) => factor.impactPoints >= 0));
});
