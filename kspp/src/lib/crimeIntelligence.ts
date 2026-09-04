import type { FirRecord } from "./cases";
import { predictHotspotRisk } from "./hotspotModel.ts";
import type { TrainedHotspotModel } from "./hotspotModel.ts";
import { isKarnatakaCoordinate } from "./geoScope.ts";

export type MapMode = "live" | "forecast";

export type Hotspot = {
  id: string;
  name: string;
  station: string;
  latitude: number;
  longitude: number;
  liveRisk: number;
  category: string;
  peakWindow: string;
  nearbyCases: number;
  recentCases: number;
  heinousCases: number;
  trend: number;
  sourceRecordIds: string[];
};

const DAY_MS = 86_400_000;
const DENSITY_RADIUS_KM = 1.5;
const SPATIAL_CELL_DEGREES = 0.02;
const MAX_RENDERED_AREAS = 2500;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const coordinate = (value: string | undefined) => {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const timestamp = (record: FirRecord) => {
  const raw = record.raw;
  const value = raw.IncidentFromDate || raw.CrimeRegisteredDate || record.date;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const hourFromRecord = (record: FirRecord) => {
  const candidates = [
    record.raw.IncidentFromTime,
    record.raw.CrimeTime,
    record.raw.IncidentTime,
    record.raw.CrimeRegisteredDate,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    const match = value.match(/(?:T|\s|^)([01]?\d|2[0-3]):[0-5]\d/);
    if (match) return Number(match[1]);
  }
  return null;
};

const radians = (value: number) => (value * Math.PI) / 180;

const distanceKm = (left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }) => {
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const categoryFrom = (records: FirRecord[]) => {
  const counts = new Map<string, number>();
  for (const record of records) {
    const category = record.raw.CrimeSubHead || record.raw.CrimeHead || record.category;
    if (category) counts.set(category, (counts.get(category) || 0) + 1);
  }
  let selected = "Reported crime";
  let maximum = 0;
  for (const [category, count] of counts) {
    if (count > maximum) {
      selected = category;
      maximum = count;
    }
  }
  return selected;
};

const locationName = (record: FirRecord) => {
  const raw = record.raw;
  return raw.PlaceOfOccurrence || raw.PlaceOfIncident || raw.CrimeLocation ||
    raw.Location || raw.IncidentPlace || raw.Address ||
    record.station || record.label;
};

const peakWindow = (records: FirRecord[]) => {
  const bins = [0, 0, 0, 0, 0, 0];
  let observed = 0;
  for (const record of records) {
    const hour = hourFromRecord(record);
    if (hour === null) continue;
    bins[Math.floor(hour / 4)] += 1;
    observed += 1;
  }
  if (!observed) return "Not recorded";
  let peakIndex = 0;
  for (let index = 1; index < bins.length; index += 1) {
    if (bins[index] > bins[peakIndex]) peakIndex = index;
  }
  const start = peakIndex * 4;
  const end = (start + 4) % 24;
  return `${String(start).padStart(2, "0")}:00–${String(end).padStart(2, "0")}:00`;
};

type GeocodedRecord = {
  record: FirRecord;
  latitude: number;
  longitude: number;
  occurredAt: number | null;
};

export type IntelligenceDataset = {
  hotspots: Hotspot[];
  geocodedRecords: number;
  totalRecords: number;
  coveragePercentage: number;
  latestRecordDate: number | null;
  totalHotspotAreas: number;
};

const dominantText = (records: FirRecord[], valueOf: (record: FirRecord) => string) => {
  const counts = new Map<string, { value: string; count: number }>();
  for (const record of records) {
    const value = String(valueOf(record) || "").trim();
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    const existing = counts.get(key);
    counts.set(key, { value: existing?.value || value, count: (existing?.count || 0) + 1 });
  }
  return Array.from(counts.values()).sort((left, right) => right.count - left.count)[0]?.value || "";
};

export const buildIntelligenceDataset = (records: FirRecord[], now = Date.now()): IntelligenceDataset => {
  const geocoded: GeocodedRecord[] = [];
  for (const record of records) {
    const latitude = coordinate(record.raw.Latitude);
    const longitude = coordinate(record.raw.Longitude);
    if (latitude === null || longitude === null) continue;
    if (!isKarnatakaCoordinate(latitude, longitude)) continue;
    geocoded.push({ record, latitude, longitude, occurredAt: timestamp(record) });
  }

  const latestRecordDate = geocoded.reduce<number | null>(
    (latest, item) => item.occurredAt !== null && (latest === null || item.occurredAt > latest)
      ? item.occurredAt
      : latest,
    null,
  );
  const referenceTime = latestRecordDate && latestRecordDate > now - (90 * DAY_MS)
    ? now
    : latestRecordDate || now;

  // Aggregate FIRs into small geographic cells before calculating density.
  // This keeps the number of map/model areas bounded even when the source
  // register grows to hundreds of thousands of rows.
  const spatialIndex = new Map<string, GeocodedRecord[]>();
  for (const item of geocoded) {
    const cellKey = `${Math.floor(item.latitude / SPATIAL_CELL_DEGREES)},${Math.floor(item.longitude / SPATIAL_CELL_DEGREES)}`;
    const cell = spatialIndex.get(cellKey);
    if (cell) cell.push(item);
    else spatialIndex.set(cellKey, [item]);
  }

  const candidates = Array.from(spatialIndex.entries()).map(([key, cellRecords]) => {
    const latitude = cellRecords.reduce((sum, item) => sum + item.latitude, 0) / cellRecords.length;
    const longitude = cellRecords.reduce((sum, item) => sum + item.longitude, 0) / cellRecords.length;
    const anchor = { latitude, longitude };
    const [cellLatitude, cellLongitude] = key.split(",").map(Number);
    const nearbyCandidates: GeocodedRecord[] = [];
    for (let latitudeOffset = -1; latitudeOffset <= 1; latitudeOffset += 1) {
      for (let longitudeOffset = -1; longitudeOffset <= 1; longitudeOffset += 1) {
        nearbyCandidates.push(...(spatialIndex.get(`${cellLatitude + latitudeOffset},${cellLongitude + longitudeOffset}`) || []));
      }
    }
    const nearby = nearbyCandidates.filter((item) => distanceKm(anchor, item) <= DENSITY_RADIUS_KM);
    let weightedDensity = 0;
    let recentCases = 0;
    let currentWeek = 0;
    let previousWeek = 0;
    let heinousCases = 0;
    for (const item of nearby) {
      const ageDays = item.occurredAt === null
        ? 90
        : Math.max(0, (referenceTime - item.occurredAt) / DAY_MS);
      const gravityWeight = /heinous|high/i.test(item.record.gravity) ? 1.35 : 1;
      weightedDensity += Math.exp(-ageDays / 30) * gravityWeight;
      if (ageDays <= 30) recentCases += 1;
      if (ageDays <= 7) currentWeek += 1;
      else if (ageDays <= 14) previousWeek += 1;
      if (/heinous|high/i.test(item.record.gravity)) heinousCases += 1;
    }
    const trend = previousWeek === 0
      ? (currentWeek > 0 ? 100 : 0)
      : clamp(Math.round(((currentWeek - previousWeek) / previousWeek) * 100), -100, 200);
    const sourceRecords = cellRecords.map((item) => item.record);
    return {
      key,
      anchor,
      sourceRecords,
      nearby,
      recentCases,
      heinousCases,
      trend,
      weightedDensity,
    };
  });

  const maximumDensity = candidates.reduce((maximum, item) => Math.max(maximum, item.weightedDensity), 0);
  const renderedCandidates = candidates
    .sort((left, right) => right.weightedDensity - left.weightedDensity)
    .slice(0, MAX_RENDERED_AREAS);
  const hotspots = renderedCandidates.map((item): Hotspot => {
    const firstRecord = item.sourceRecords[0];
    return {
      id: `fir-area-${item.key}`,
      name: dominantText(item.sourceRecords, locationName) || locationName(firstRecord),
      station: dominantText(item.sourceRecords, (record) => record.station) || firstRecord.station || "Unassigned station",
      latitude: item.anchor.latitude,
      longitude: item.anchor.longitude,
      liveRisk: maximumDensity > 0 ? Math.round((item.weightedDensity / maximumDensity) * 100) : 0,
      category: categoryFrom(item.nearby.map((nearbyItem) => nearbyItem.record)),
      peakWindow: peakWindow(item.nearby.map((nearbyItem) => nearbyItem.record)),
      nearbyCases: item.nearby.length,
      recentCases: item.recentCases,
      heinousCases: item.heinousCases,
      trend: item.trend,
      // Retain a bounded drill-down sample; aggregate counts above still use
      // every authorized FIR in the area.
      sourceRecordIds: item.sourceRecords.slice(0, 250).map((record) => record.id),
    };
  });

  return {
    hotspots,
    geocodedRecords: geocoded.length,
    totalRecords: records.length,
    coveragePercentage: records.length ? Math.round((geocoded.length / records.length) * 100) : 0,
    latestRecordDate,
    totalHotspotAreas: candidates.length,
  };
};

export const hotspotScore = (
  hotspot: Hotspot,
  mode: MapMode,
  hour: number,
  horizonDays: number,
  model: TrainedHotspotModel | null,
) => {
  if (mode === "live") return hotspot.liveRisk;
  if (!model) return 0;
  return predictHotspotRisk(model, {
    liveRisk: hotspot.liveRisk,
    recentCases: hotspot.recentCases,
      trend: hotspot.trend,
    category: hotspot.category,
    hour,
    horizonDays,
  });
};
