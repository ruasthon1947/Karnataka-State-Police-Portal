import type { FirRecord } from "./cases";

export type HotspotModelInput = {
  liveRisk: number;
  recentCases: number;
  trend: number;
  category: string;
  hour: number;
  horizonDays: number;
};

export type HotspotModelMetrics = {
  balancedAccuracy: number;
  precision: number;
  recall: number;
  specificity: number;
  brierScore: number;
  validationSamples: number;
  validationPositives: number;
  validationFrom: number;
  validationThrough: number;
  trainingSamples: number;
  trainingPositives: number;
  trainingThrough: number;
};

export type TrainedHotspotModel = {
  version: "1.1";
  dataFingerprint: string;
  dataThrough: number;
  trainedAt: number;
  hiddenWeights: number[][];
  hiddenBiases: number[];
  outputWeights: number[];
  outputBias: number;
  featureMeans: number[];
  featureScales: number[];
  metrics: HotspotModelMetrics;
};

export type HotspotTrainingResult = {
  model: TrainedHotspotModel | null;
  reason: string;
  datedGeocodedRecords: number;
  historyDays: number;
};

type ModelEvent = {
  cell: string;
  occurredAt: number;
  hour: number;
  severity: number;
};

type TrainingSample = {
  cutoff: number;
  outcomeThrough: number;
  features: number[];
  target: 0 | 1;
};

const DAY_MS = 86_400_000;
const CELL_DEGREES = 0.02;
const HIDDEN_UNITS = 6;
const MAX_SAMPLES = 6000;
const EPOCHS = 140;
const LEARNING_RATE = 0.025;
const L2 = 0.0004;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const sigmoid = (value: number) => 1 / (1 + Math.exp(-clamp(value, -30, 30)));

const categorySeverity = (category: string) => {
  const normalized = category.toLowerCase();
  if (/murder|narcotic|weapon|assault|heinous|rape|kidnap/.test(normalized)) return 1;
  if (/vehicle|theft|breaking|robbery|accident|burglary/.test(normalized)) return 0.7;
  if (/cyber|fraud|cheat|forgery/.test(normalized)) return 0.52;
  return 0.35;
};

const eventHour = (record: FirRecord) => {
  for (const candidate of [record.raw.IncidentFromTime, record.raw.CrimeTime, record.raw.IncidentTime, record.raw.CrimeRegisteredDate]) {
    const match = String(candidate || "").match(/(?:T|\s|^)([01]?\d|2[0-3]):[0-5]\d/);
    if (match) return Number(match[1]);
  }
  return 12;
};

const recordTimestamp = (record: FirRecord) => {
  const parsed = Date.parse(String(record.raw.IncidentFromDate || record.raw.CrimeRegisteredDate || record.date || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const modelEvents = (records: FirRecord[]) => {
  const events: ModelEvent[] = [];
  for (const record of records) {
    const latitude = Number.parseFloat(String(record.raw.Latitude || ""));
    const longitude = Number.parseFloat(String(record.raw.Longitude || ""));
    const occurredAt = recordTimestamp(record);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || occurredAt === null) continue;
    if (latitude < 12.78 || latitude > 13.17 || longitude < 77.42 || longitude > 77.82) continue;
    const category = record.raw.CrimeSubHead || record.raw.CrimeHead || record.category;
    events.push({
      cell: `${Math.floor(latitude / CELL_DEGREES)},${Math.floor(longitude / CELL_DEGREES)}`,
      occurredAt,
      hour: eventHour(record),
      severity: Math.max(categorySeverity(category), /heinous|high/i.test(record.gravity) ? 1 : 0),
    });
  }
  return events.sort((left, right) => left.occurredAt - right.occurredAt);
};

const rawFeatureVector = (input: HotspotModelInput) => {
  const angle = (input.hour / 24) * Math.PI * 2;
  return [
    clamp(input.liveRisk / 100, 0, 1),
    clamp(input.recentCases / 20, 0, 1),
    clamp(input.trend / 100, -1, 2),
    categorySeverity(input.category),
    Math.sin(angle),
    Math.cos(angle),
    clamp(input.horizonDays / 30, 0, 1),
  ];
};

const createSamples = (events: ModelEvent[]) => {
  const byCell = new Map<string, ModelEvent[]>();
  for (const event of events) byCell.set(event.cell, [...(byCell.get(event.cell) || []), event]);
  const cells = Array.from(byCell.keys());
  const firstDate = events[0].occurredAt;
  const lastDate = events[events.length - 1].occurredAt;
  const samples: TrainingSample[] = [];

  for (let cutoff = firstDate + (30 * DAY_MS); cutoff <= lastDate - DAY_MS; cutoff += 7 * DAY_MS) {
    const historyCounts = new Map<string, number>();
    for (const cell of cells) {
      const count = (byCell.get(cell) || []).reduce(
        (total, event) => total + (event.occurredAt <= cutoff && event.occurredAt > cutoff - (30 * DAY_MS) ? 1 : 0),
        0,
      );
      historyCounts.set(cell, count);
    }
    const maximumHistory = Math.max(...historyCounts.values(), 1);

    for (const cell of cells) {
      const cellEvents = byCell.get(cell) || [];
      const priorEvents = cellEvents.filter((event) => event.occurredAt <= cutoff);
      // A cell becomes eligible only after its first recorded FIR. Quiet later
      // windows are real negative examples and must not be discarded.
      if (!priorEvents.length) continue;
      const history30 = cellEvents.filter((event) => event.occurredAt <= cutoff && event.occurredAt > cutoff - (30 * DAY_MS));
      const recent7 = history30.filter((event) => event.occurredAt > cutoff - (7 * DAY_MS));
      const previous7 = history30.filter((event) => event.occurredAt <= cutoff - (7 * DAY_MS) && event.occurredAt > cutoff - (14 * DAY_MS));
      const trend = previous7.length
        ? ((recent7.length - previous7.length) / previous7.length) * 100
        : (recent7.length ? 100 : 0);
      const severityHistory = history30.length ? history30 : priorEvents.slice(-20);
      const severity = severityHistory.reduce((sum, event) => sum + event.severity, 0) / severityHistory.length;

      for (const horizonDays of [1, 7, 30]) {
        if (cutoff + (horizonDays * DAY_MS) > lastDate) continue;
        for (const hour of [4, 12, 20]) {
          const futureCount = cellEvents.reduce((total, event) => {
            const hourDistance = Math.abs(event.hour - hour);
            const inHourWindow = Math.min(hourDistance, 24 - hourDistance) <= 4;
            return total + (event.occurredAt > cutoff && event.occurredAt <= cutoff + (horizonDays * DAY_MS) && inHourWindow ? 1 : 0);
          }, 0);
          samples.push({
            cutoff,
            outcomeThrough: cutoff + (horizonDays * DAY_MS),
            features: rawFeatureVector({
              liveRisk: (history30.length / maximumHistory) * 100,
              recentCases: history30.length,
              trend,
              category: severity >= 0.85 ? "heinous" : severity >= 0.58 ? "theft" : "reported crime",
              hour,
              horizonDays,
            }),
            target: futureCount > 0 ? 1 : 0,
          });
        }
      }
    }
  }

  if (samples.length <= MAX_SAMPLES) return samples;
  const step = samples.length / MAX_SAMPLES;
  return Array.from({ length: MAX_SAMPLES }, (_, index) => samples[Math.floor(index * step)]);
};

const fingerprint = (events: ModelEvent[]) => {
  let hash = 2166136261;
  for (const event of events) {
    const value = `${event.cell}:${event.occurredAt}:${event.hour}`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const seededRandom = (seedValue: number) => {
  let seed = seedValue >>> 0;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4_294_967_296;
  };
};

const standardize = (features: number[], means: number[], scales: number[]) =>
  features.map((value, index) => (value - means[index]) / scales[index]);

const outputProbability = (model: Pick<TrainedHotspotModel, "hiddenWeights" | "hiddenBiases" | "outputWeights" | "outputBias" | "featureMeans" | "featureScales">, features: number[]) => {
  const standardized = standardize(features, model.featureMeans, model.featureScales);
  const hidden = model.hiddenWeights.map((weights, unit) =>
    Math.tanh(weights.reduce((sum, weight, index) => sum + (weight * standardized[index]), model.hiddenBiases[unit])),
  );
  return sigmoid(hidden.reduce((sum, activation, index) => sum + (activation * model.outputWeights[index]), model.outputBias));
};

const validationMetrics = (model: TrainedHotspotModel, samples: TrainingSample[], trainingSamples: TrainingSample[]): HotspotModelMetrics => {
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let brierTotal = 0;
  for (const sample of samples) {
    const probability = outputProbability(model, sample.features);
    const predicted = probability >= 0.5 ? 1 : 0;
    brierTotal += (probability - sample.target) ** 2;
    if (predicted === 1 && sample.target === 1) truePositive += 1;
    else if (predicted === 0 && sample.target === 0) trueNegative += 1;
    else if (predicted === 1) falsePositive += 1;
    else falseNegative += 1;
  }
  const recall = truePositive / Math.max(truePositive + falseNegative, 1);
  const specificity = trueNegative / Math.max(trueNegative + falsePositive, 1);
  const precision = truePositive / Math.max(truePositive + falsePositive, 1);
  return {
    balancedAccuracy: Math.round(((recall + specificity) / 2) * 100),
    precision: Math.round(precision * 100),
    recall: Math.round(recall * 100),
    specificity: Math.round(specificity * 100),
    brierScore: Number((brierTotal / Math.max(samples.length, 1)).toFixed(3)),
    validationSamples: samples.length,
    validationPositives: samples.reduce((sum, sample) => sum + sample.target, 0),
    validationFrom: Math.min(...samples.map((sample) => sample.cutoff)),
    validationThrough: Math.max(...samples.map((sample) => sample.outcomeThrough)),
    trainingSamples: trainingSamples.length,
    trainingPositives: trainingSamples.reduce((sum, sample) => sum + sample.target, 0),
    trainingThrough: Math.max(...trainingSamples.map((sample) => sample.outcomeThrough)),
  };
};

export const trainHotspotModel = (records: FirRecord[]): HotspotTrainingResult => {
  const events = modelEvents(records);
  if (events.length < 60) {
    return { model: null, reason: "At least 60 dated, geocoded FIRs are required for training.", datedGeocodedRecords: events.length, historyDays: 0 };
  }
  const historyDays = Math.floor((events[events.length - 1].occurredAt - events[0].occurredAt) / DAY_MS);
  if (historyDays < 45) {
    return { model: null, reason: "At least 45 days of FIR history are required for chronological validation.", datedGeocodedRecords: events.length, historyDays };
  }

  const samples = createSamples(events).sort((left, right) => left.cutoff - right.cutoff);
  if (samples.length < 100) {
    return { model: null, reason: "The available history did not produce enough training windows.", datedGeocodedRecords: events.length, historyDays };
  }
  const cutoffs = Array.from(new Set(samples.map((sample) => sample.cutoff))).sort((left, right) => left - right);
  const validationStart = cutoffs[Math.min(cutoffs.length - 1, Math.max(1, Math.floor(cutoffs.length * 0.8)))];
  // Purge samples whose outcome window reaches into the holdout period. This
  // prevents a 30-day training label from seeing incidents used by validation.
  const trainingSamples = samples.filter((sample) => sample.outcomeThrough < validationStart);
  const validationSamples = samples.filter((sample) => sample.cutoff >= validationStart);
  if (trainingSamples.length < 80 || validationSamples.length < 20) {
    return { model: null, reason: "The available history did not leave enough non-overlapping chronological validation windows.", datedGeocodedRecords: events.length, historyDays };
  }
  const trainPositives = trainingSamples.reduce((sum, sample) => sum + sample.target, 0);
  const validationPositives = validationSamples.reduce((sum, sample) => sum + sample.target, 0);
  if (trainPositives < 10 || trainingSamples.length - trainPositives < 10 || validationPositives < 3 || validationSamples.length - validationPositives < 3) {
    return { model: null, reason: "Training and validation require both incident and no-incident historical windows.", datedGeocodedRecords: events.length, historyDays };
  }

  const featureCount = trainingSamples[0].features.length;
  const featureMeans = Array.from({ length: featureCount }, (_, index) =>
    trainingSamples.reduce((sum, sample) => sum + sample.features[index], 0) / trainingSamples.length,
  );
  const featureScales = Array.from({ length: featureCount }, (_, index) => {
    const variance = trainingSamples.reduce((sum, sample) => sum + ((sample.features[index] - featureMeans[index]) ** 2), 0) / trainingSamples.length;
    return Math.max(Math.sqrt(variance), 0.05);
  });

  const modelFingerprint = fingerprint(events);
  const random = seededRandom(Number.parseInt(modelFingerprint, 16));
  const hiddenWeights = Array.from({ length: HIDDEN_UNITS }, () =>
    Array.from({ length: featureCount }, () => (random() - 0.5) * 0.35),
  );
  const hiddenBiases = Array.from({ length: HIDDEN_UNITS }, () => 0);
  const outputWeights = Array.from({ length: HIDDEN_UNITS }, () => (random() - 0.5) * 0.35);
  let outputBias = Math.log(trainPositives / (trainingSamples.length - trainPositives));
  const positiveWeight = trainingSamples.length / (2 * trainPositives);
  const negativeWeight = trainingSamples.length / (2 * (trainingSamples.length - trainPositives));

  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    const order = Array.from({ length: trainingSamples.length }, (_, index) => index);
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
    }
    const epochRate = LEARNING_RATE * (1 - (epoch / EPOCHS) * 0.7);
    for (const sampleIndex of order) {
      const sample = trainingSamples[sampleIndex];
      const features = standardize(sample.features, featureMeans, featureScales);
      const hidden = hiddenWeights.map((weights, unit) =>
        Math.tanh(weights.reduce((sum, weight, index) => sum + (weight * features[index]), hiddenBiases[unit])),
      );
      const probability = sigmoid(hidden.reduce((sum, activation, index) => sum + (activation * outputWeights[index]), outputBias));
      const classWeight = sample.target ? positiveWeight : negativeWeight;
      const outputGradient = (probability - sample.target) * classWeight;
      const previousOutputWeights = [...outputWeights];
      for (let unit = 0; unit < HIDDEN_UNITS; unit += 1) {
        outputWeights[unit] -= epochRate * ((outputGradient * hidden[unit]) + (L2 * outputWeights[unit]));
      }
      outputBias -= epochRate * outputGradient;
      for (let unit = 0; unit < HIDDEN_UNITS; unit += 1) {
        const hiddenGradient = outputGradient * previousOutputWeights[unit] * (1 - (hidden[unit] ** 2));
        for (let feature = 0; feature < featureCount; feature += 1) {
          hiddenWeights[unit][feature] -= epochRate * ((hiddenGradient * features[feature]) + (L2 * hiddenWeights[unit][feature]));
        }
        hiddenBiases[unit] -= epochRate * hiddenGradient;
      }
    }
  }

  const model: TrainedHotspotModel = {
    version: "1.1",
    dataFingerprint: modelFingerprint,
    dataThrough: events[events.length - 1].occurredAt,
    trainedAt: Date.now(),
    hiddenWeights,
    hiddenBiases,
    outputWeights,
    outputBias,
    featureMeans,
    featureScales,
    metrics: {
      balancedAccuracy: 0,
      precision: 0,
      recall: 0,
      specificity: 0,
      brierScore: 0,
      validationSamples: 0,
      validationPositives: 0,
      validationFrom: 0,
      validationThrough: 0,
      trainingSamples: 0,
      trainingPositives: 0,
      trainingThrough: 0,
    },
  };
  model.metrics = validationMetrics(model, validationSamples, trainingSamples);
  if (model.metrics.balancedAccuracy < 55 || model.metrics.brierScore > 0.35) {
    return {
      model: null,
      reason: `Chronological validation did not pass the deployment gate (balanced accuracy ${model.metrics.balancedAccuracy}%, Brier ${model.metrics.brierScore}).`,
      datedGeocodedRecords: events.length,
      historyDays,
    };
  }
  return { model, reason: "", datedGeocodedRecords: events.length, historyDays };
};

export const predictHotspotRisk = (model: TrainedHotspotModel, input: HotspotModelInput) =>
  Math.round(outputProbability(model, rawFeatureVector(input)) * 100);
