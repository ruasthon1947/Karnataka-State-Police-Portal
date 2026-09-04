import type { FirRecord } from "./cases";
import { isKarnatakaCoordinate } from "./geoScope.ts";

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
  balancedAccuracyLow: number;
  balancedAccuracyHigh: number;
  baselineBalancedAccuracy: number;
  accuracyUplift: number;
  precision: number;
  f1Score: number;
  recall: number;
  specificity: number;
  validationEventRate: number;
  precisionLift: number;
  alertThreshold: number;
  brierScore: number;
  baselineBrierScore: number;
  uncertaintyMargin: number;
  confidenceLevel: "high" | "medium" | "low";
  backtestWindows: number;
  validationSamples: number;
  validationPositives: number;
  validationFrom: number;
  validationThrough: number;
  trainingSamples: number;
  trainingPositives: number;
  trainingThrough: number;
};

export type TrainedHotspotModel = {
  version: "1.4";
  dataFingerprint: string;
  dataThrough: number;
  trainedAt: number;
  hiddenWeights: number[][];
  hiddenBiases: number[];
  outputWeights: number[];
  outputBias: number;
  positiveClassWeight: number;
  negativeClassWeight: number;
  decisionThreshold: number;
  featureMeans: number[];
  featureScales: number[];
  metrics: HotspotModelMetrics;
};

export type HotspotTrainingResult = {
  model: TrainedHotspotModel | null;
  evaluation: HotspotModelMetrics | null;
  status: "validated" | "below_baseline" | "insufficient_data";
  reason: string;
  datedGeocodedRecords: number;
  modelRecordsUsed: number;
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
  horizonDays: number;
  features: number[];
  target: 0 | 1;
};

const DAY_MS = 86_400_000;
const CELL_DEGREES = 0.02;
const HIDDEN_UNITS = 6;
const MAX_SAMPLES = 6000;
const MAX_MODEL_EVENTS = 100_000;
const MAX_MODEL_CELLS = 256;
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
    if (!isKarnatakaCoordinate(latitude, longitude)) continue;
    const category = record.raw.CrimeSubHead || record.raw.CrimeHead || record.category;
    events.push({
      cell: `${Math.floor(latitude / CELL_DEGREES)},${Math.floor(longitude / CELL_DEGREES)}`,
      occurredAt,
      hour: eventHour(record),
      severity: Math.max(categorySeverity(category), /heinous|high/i.test(record.gravity) ? 1 : 0),
    });
  }
  events.sort((left, right) => left.occurredAt - right.occurredAt);
  if (events.length <= MAX_MODEL_EVENTS) return { events, total: events.length };
  // Keep chronological coverage while bounding neural-training work. Every FIR
  // still contributes to the live spatial aggregation; this cap applies only
  // to the repeatable model-training sample.
  const step = events.length / MAX_MODEL_EVENTS;
  const sampled = Array.from(
    { length: MAX_MODEL_EVENTS },
    (_, index) => events[Math.min(events.length - 1, Math.floor(index * step))],
  );
  return { events: sampled, total: events.length };
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
  let byCell = new Map<string, ModelEvent[]>();
  for (const event of events) {
    const cell = byCell.get(event.cell);
    if (cell) cell.push(event);
    else byCell.set(event.cell, [event]);
  }
  if (byCell.size > MAX_MODEL_CELLS) {
    const ranked = Array.from(byCell.entries()).sort((left, right) => right[1].length - left[1].length);
    const busiest = ranked.slice(0, MAX_MODEL_CELLS / 2);
    const remaining = ranked.slice(MAX_MODEL_CELLS / 2).sort(([left], [right]) => left.localeCompare(right));
    const geographicStep = remaining.length / (MAX_MODEL_CELLS / 2);
    const distributed = Array.from(
      { length: MAX_MODEL_CELLS / 2 },
      (_, index) => remaining[Math.min(remaining.length - 1, Math.floor(index * geographicStep))],
    );
    byCell = new Map([...busiest, ...distributed]);
  }
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
            horizonDays,
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

const outputProbability = (model: Pick<TrainedHotspotModel, "hiddenWeights" | "hiddenBiases" | "outputWeights" | "outputBias" | "positiveClassWeight" | "negativeClassWeight" | "featureMeans" | "featureScales">, features: number[]) => {
  const standardized = standardize(features, model.featureMeans, model.featureScales);
  const hidden = model.hiddenWeights.map((weights, unit) =>
    Math.tanh(weights.reduce((sum, weight, index) => sum + (weight * standardized[index]), model.hiddenBiases[unit])),
  );
  const weightedProbability = sigmoid(hidden.reduce((sum, activation, index) => sum + (activation * model.outputWeights[index]), model.outputBias));
  // Class balancing is useful while training rare-event data, but its raw
  // output overstates event probability. Reverse that weighting before a
  // percentage is evaluated or shown to an officer.
  const denominator = (model.positiveClassWeight * (1 - weightedProbability)) + (model.negativeClassWeight * weightedProbability);
  return denominator > 0 ? (weightedProbability * model.negativeClassWeight) / denominator : weightedProbability;
};

type ScoredOutcome = { probability: number; target: 0 | 1 };

const scoreOutcomes = (outcomes: ScoredOutcome[], threshold = 0.5) => {
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let brierTotal = 0;
  for (const { probability, target } of outcomes) {
    const predicted = probability >= threshold ? 1 : 0;
    brierTotal += (probability - target) ** 2;
    if (predicted === 1 && target === 1) truePositive += 1;
    else if (predicted === 0 && target === 0) trueNegative += 1;
    else if (predicted === 1) falsePositive += 1;
    else falseNegative += 1;
  }
  const recall = truePositive / Math.max(truePositive + falseNegative, 1);
  const specificity = trueNegative / Math.max(trueNegative + falsePositive, 1);
  const precision = truePositive / Math.max(truePositive + falsePositive, 1);
  const f1Score = (2 * precision * recall) / Math.max(precision + recall, Number.EPSILON);
  return {
    balancedAccuracy: ((recall + specificity) / 2) * 100,
    precision: precision * 100,
    f1Score: f1Score * 100,
    recall: recall * 100,
    specificity: specificity * 100,
    brierScore: brierTotal / Math.max(outcomes.length, 1),
  };
};

const operationalThreshold = (outcomes: ScoredOutcome[]) => {
  const scored = Array.from({ length: 99 }, (_, index) => {
    const threshold = (index + 1) / 100;
    return { threshold, metrics: scoreOutcomes(outcomes, threshold) };
  });
  const bestBalancedAccuracy = Math.max(...scored.map(({ metrics }) => metrics.balancedAccuracy));
  const eligible = scored.filter(({ metrics }) =>
    metrics.recall >= 55 && metrics.balancedAccuracy >= bestBalancedAccuracy - 4,
  );
  if (!eligible.length) return balancedThreshold(outcomes);
  eligible.sort((left, right) =>
    right.metrics.precision - left.metrics.precision
    || right.metrics.f1Score - left.metrics.f1Score
    || right.metrics.balancedAccuracy - left.metrics.balancedAccuracy,
  );
  return eligible[0].threshold;
};

const balancedThreshold = (outcomes: ScoredOutcome[]) => {
  let bestThreshold = 0.5;
  let bestAccuracy = -1;
  // Threshold selection uses older training data only. The chosen value is
  // then frozen before the newer chronological back-test is evaluated.
  for (let step = 1; step < 100; step += 1) {
    const threshold = step / 100;
    const accuracy = scoreOutcomes(outcomes, threshold).balancedAccuracy;
    if (accuracy > bestAccuracy) {
      bestAccuracy = accuracy;
      bestThreshold = threshold;
    }
  }
  return bestThreshold;
};

const percentile = (values: number[], position: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(position * (sorted.length - 1))))];
};

const validationMetrics = (
  model: TrainedHotspotModel,
  samples: TrainingSample[],
  trainingSamples: TrainingSample[],
  seed: number,
): HotspotModelMetrics => {
  const modelOutcomes = samples.map((sample) => ({
    probability: outputProbability(model, sample.features),
    target: sample.target,
  }));
  const trainingModelOutcomes = trainingSamples.map((sample) => ({
    probability: outputProbability(model, sample.features),
    target: sample.target,
  }));
  // Freeze a training-only operational threshold that reduces false patrol
  // alerts while retaining at least 55% recall and near-best balanced accuracy.
  model.decisionThreshold = operationalThreshold(trainingModelOutcomes);
  const overallHistoricalRate = trainingSamples.reduce((sum, sample) => sum + sample.target, 0) / trainingSamples.length;
  const baselineKey = (sample: TrainingSample) => `${sample.horizonDays}:${Math.min(3, Math.floor(sample.features[0] * 4))}`;
  const baselineGroups = new Map<string, { positives: number; total: number }>();
  for (const sample of trainingSamples) {
    const key = baselineKey(sample);
    const group = baselineGroups.get(key) || { positives: 0, total: 0 };
    group.positives += sample.target;
    group.total += 1;
    baselineGroups.set(key, group);
  }
  const baselineProbability = (sample: TrainingSample) => {
    const group = baselineGroups.get(baselineKey(sample));
    if (!group) return overallHistoricalRate;
    // Eight prior-equivalent observations keep a sparse density band from
    // becoming an unrealistically certain 0% or 100% baseline.
    return (group.positives + (overallHistoricalRate * 8)) / (group.total + 8);
  };
  const baselineTrainingOutcomes = trainingSamples.map((sample) => ({
    probability: baselineProbability(sample),
    target: sample.target,
  }));
  const baselineThreshold = balancedThreshold(baselineTrainingOutcomes);
  const baselineOutcomes = samples.map((sample) => ({
    probability: baselineProbability(sample),
    target: sample.target,
  }));
  const scoredModel = scoreOutcomes(modelOutcomes, model.decisionThreshold);
  const scoredBaseline = scoreOutcomes(baselineOutcomes, baselineThreshold);
  const random = seededRandom(seed ^ 0x9e3779b9);
  const outcomesByWeek = new Map<number, ScoredOutcome[]>();
  samples.forEach((sample, index) => outcomesByWeek.set(sample.cutoff, [
    ...(outcomesByWeek.get(sample.cutoff) || []),
    modelOutcomes[index],
  ]));
  const weeklyOutcomes = Array.from(outcomesByWeek.values());
  const bootstrappedAccuracy: number[] = [];
  for (let iteration = 0; iteration < 240; iteration += 1) {
    const resample = Array.from({ length: weeklyOutcomes.length }, () => weeklyOutcomes[Math.floor(random() * weeklyOutcomes.length)]).flat();
    const positives = resample.reduce((sum, outcome) => sum + outcome.target, 0);
    if (positives > 0 && positives < resample.length) bootstrappedAccuracy.push(scoreOutcomes(resample, model.decisionThreshold).balancedAccuracy);
  }
  const balancedAccuracyPoint = Math.round(scoredModel.balancedAccuracy);
  const balancedAccuracyLow = Math.min(balancedAccuracyPoint, Math.round(percentile(bootstrappedAccuracy, 0.05)));
  const balancedAccuracyHigh = Math.max(balancedAccuracyPoint, Math.round(percentile(bootstrappedAccuracy, 0.95)));
  const positiveErrors = modelOutcomes.filter((outcome) => outcome.target === 1).map((outcome) => Math.abs(outcome.probability - 1));
  const negativeErrors = modelOutcomes.filter((outcome) => outcome.target === 0).map((outcome) => outcome.probability);
  // Weight incident and no-incident errors equally so a large number of easy
  // negatives cannot make the officer-facing uncertainty band look too tight.
  const uncertaintyMargin = Math.round(((percentile(positiveErrors, 0.8) + percentile(negativeErrors, 0.8)) / 2) * 100);
  const accuracyUplift = Math.round(scoredModel.balancedAccuracy - scoredBaseline.balancedAccuracy);
  const validationEventRate = (samples.reduce((sum, sample) => sum + sample.target, 0) / samples.length) * 100;
  const backtestWindows = new Set(samples.map((sample) => sample.cutoff)).size;
  const intervalWidth = balancedAccuracyHigh - balancedAccuracyLow;
  const confidenceLevel: HotspotModelMetrics["confidenceLevel"] =
    backtestWindows >= 8 && samples.length >= 200 && accuracyUplift >= 5 && intervalWidth <= 12 && scoredModel.brierScore <= scoredBaseline.brierScore
      ? "high"
      : backtestWindows >= 4 && samples.length >= 80 && accuracyUplift > 0 && intervalWidth <= 25
        ? "medium"
        : "low";

  return {
    balancedAccuracy: balancedAccuracyPoint,
    balancedAccuracyLow,
    balancedAccuracyHigh,
    baselineBalancedAccuracy: Math.round(scoredBaseline.balancedAccuracy),
    accuracyUplift,
    precision: Math.round(scoredModel.precision),
    f1Score: Math.round(scoredModel.f1Score),
    recall: Math.round(scoredModel.recall),
    specificity: Math.round(scoredModel.specificity),
    validationEventRate: Math.round(validationEventRate),
    precisionLift: Number((scoredModel.precision / Math.max(validationEventRate, Number.EPSILON)).toFixed(1)),
    alertThreshold: Math.round(model.decisionThreshold * 100),
    brierScore: Number(scoredModel.brierScore.toFixed(3)),
    baselineBrierScore: Number(scoredBaseline.brierScore.toFixed(3)),
    uncertaintyMargin,
    confidenceLevel,
    backtestWindows,
    validationSamples: samples.length,
    validationPositives: samples.reduce((sum, sample) => sum + sample.target, 0),
    validationFrom: Math.min(...samples.map((sample) => sample.cutoff)),
    validationThrough: Math.max(...samples.map((sample) => sample.outcomeThrough)),
    trainingSamples: trainingSamples.length,
    trainingPositives: trainingSamples.reduce((sum, sample) => sum + sample.target, 0),
    trainingThrough: Math.max(...trainingSamples.map((sample) => sample.outcomeThrough)),
  };
};

const insufficientResult = (
  reason: string,
  datedGeocodedRecords: number,
  historyDays: number,
  modelRecordsUsed = datedGeocodedRecords,
): HotspotTrainingResult => ({
  model: null,
  evaluation: null,
  status: "insufficient_data",
  reason,
  datedGeocodedRecords,
  modelRecordsUsed,
  historyDays,
});

export const trainHotspotModel = (records: FirRecord[]): HotspotTrainingResult => {
  const modelEventResult = modelEvents(records);
  const events = modelEventResult.events;
  if (modelEventResult.total < 60) {
    return insufficientResult("At least 60 dated, geocoded FIRs are required for training.", modelEventResult.total, 0, events.length);
  }
  const historyDays = Math.floor((events[events.length - 1].occurredAt - events[0].occurredAt) / DAY_MS);
  if (historyDays < 45) {
    return insufficientResult("At least 45 days of FIR history are required for chronological validation.", modelEventResult.total, historyDays, events.length);
  }

  const samples = createSamples(events).sort((left, right) => left.cutoff - right.cutoff);
  if (samples.length < 100) {
    return insufficientResult("The available history did not produce enough training windows.", modelEventResult.total, historyDays, events.length);
  }
  const cutoffs = Array.from(new Set(samples.map((sample) => sample.cutoff))).sort((left, right) => left - right);
  const validationStart = cutoffs[Math.min(cutoffs.length - 1, Math.max(1, Math.floor(cutoffs.length * 0.8)))];
  // Purge samples whose outcome window reaches into the holdout period. This
  // prevents a 30-day training label from seeing incidents used by validation.
  const trainingSamples = samples.filter((sample) => sample.outcomeThrough < validationStart);
  const validationSamples = samples.filter((sample) => sample.cutoff >= validationStart);
  if (trainingSamples.length < 80 || validationSamples.length < 20) {
    return insufficientResult("The available history did not leave enough non-overlapping chronological validation windows.", modelEventResult.total, historyDays, events.length);
  }
  const trainPositives = trainingSamples.reduce((sum, sample) => sum + sample.target, 0);
  const validationPositives = validationSamples.reduce((sum, sample) => sum + sample.target, 0);
  if (trainPositives < 10 || trainingSamples.length - trainPositives < 10 || validationPositives < 3 || validationSamples.length - validationPositives < 3) {
    return insufficientResult("Training and validation require both incident and no-incident historical windows.", modelEventResult.total, historyDays, events.length);
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
    version: "1.4",
    dataFingerprint: modelFingerprint,
    dataThrough: events[events.length - 1].occurredAt,
    trainedAt: Date.now(),
    hiddenWeights,
    hiddenBiases,
    outputWeights,
    outputBias,
    positiveClassWeight: positiveWeight,
    negativeClassWeight: negativeWeight,
    decisionThreshold: 0.5,
    featureMeans,
    featureScales,
    metrics: {
      balancedAccuracy: 0,
      balancedAccuracyLow: 0,
      balancedAccuracyHigh: 0,
      baselineBalancedAccuracy: 0,
      accuracyUplift: 0,
      precision: 0,
      f1Score: 0,
      recall: 0,
      specificity: 0,
      validationEventRate: 0,
      precisionLift: 0,
      alertThreshold: 0,
      brierScore: 0,
      baselineBrierScore: 0,
      uncertaintyMargin: 0,
      confidenceLevel: "low",
      backtestWindows: 0,
      validationSamples: 0,
      validationPositives: 0,
      validationFrom: 0,
      validationThrough: 0,
      trainingSamples: 0,
      trainingPositives: 0,
      trainingThrough: 0,
    },
  };
  model.metrics = validationMetrics(model, validationSamples, trainingSamples, Number.parseInt(modelFingerprint, 16));
  if (
    model.metrics.balancedAccuracy < 55
    || model.metrics.brierScore > 0.35
    || model.metrics.accuracyUplift <= 0
    || model.metrics.brierScore > model.metrics.baselineBrierScore
  ) {
    return {
      model: null,
      evaluation: model.metrics,
      status: "below_baseline",
      reason: `Forecast hidden: balanced accuracy was ${model.metrics.balancedAccuracy}% versus ${model.metrics.baselineBalancedAccuracy}%, and probability error was ${model.metrics.brierScore} versus ${model.metrics.baselineBrierScore} (lower is better).`,
      datedGeocodedRecords: modelEventResult.total,
      modelRecordsUsed: events.length,
      historyDays,
    };
  }
  return { model, evaluation: model.metrics, status: "validated", reason: "", datedGeocodedRecords: modelEventResult.total, modelRecordsUsed: events.length, historyDays };
};

export type HotspotForecastFactor = {
  id: "density" | "recentCases" | "trend" | "crimePattern" | "time" | "window";
  direction: "raises" | "lowers";
  impactPoints: number;
};

export type HotspotForecast = {
  risk: number;
  lowerBound: number;
  upperBound: number;
  confidenceLevel: HotspotModelMetrics["confidenceLevel"];
  factors: HotspotForecastFactor[];
};

export const predictHotspotForecast = (model: TrainedHotspotModel, input: HotspotModelInput): HotspotForecast => {
  const features = rawFeatureVector(input);
  const probability = outputProbability(model, features);
  const groups: Array<{ id: HotspotForecastFactor["id"]; indices: number[] }> = [
    { id: "density", indices: [0] },
    { id: "recentCases", indices: [1] },
    { id: "trend", indices: [2] },
    { id: "crimePattern", indices: [3] },
    { id: "time", indices: [4, 5] },
    { id: "window", indices: [6] },
  ];
  const factors = groups.map(({ id, indices }) => {
    const typicalFeatures = [...features];
    for (const index of indices) typicalFeatures[index] = model.featureMeans[index];
    const impact = Math.round((probability - outputProbability(model, typicalFeatures)) * 100);
    return { id, direction: impact >= 0 ? "raises" as const : "lowers" as const, impactPoints: Math.abs(impact) };
  }).sort((left, right) => right.impactPoints - left.impactPoints).slice(0, 3);
  const risk = Math.round(probability * 100);
  return {
    risk,
    lowerBound: clamp(risk - model.metrics.uncertaintyMargin, 0, 100),
    upperBound: clamp(risk + model.metrics.uncertaintyMargin, 0, 100),
    confidenceLevel: model.metrics.confidenceLevel,
    factors,
  };
};

export const predictHotspotRisk = (model: TrainedHotspotModel, input: HotspotModelInput) =>
  predictHotspotForecast(model, input).risk;




