import { fetchCases, type CaseRecord } from "./cases";
import type { ChatMapContext, ChatMapPoint, ChatMessage } from "./chatApi";
import { displayIdentifier } from "./taskEngine";

const CASE_FIELDS = ["CaseNo", "CrimeNo", "CaseMasterID"];
const LOCATION_FIELDS = [
  "PoliceStation",
  "PlaceOfOccurrence",
  "PlaceOfIncident",
  "CrimeLocation",
  "Location",
  "IncidentPlace",
  "Address",
];

const normalize = (value: unknown) => String(value || "").trim().toLowerCase();
const coordinate = (value: unknown, min: number, max: number) => {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

const coordinatesFor = (record: CaseRecord) => {
  const latitude = coordinate(record.Latitude, -90, 90);
  const longitude = coordinate(record.Longitude, -180, 180);
  return latitude === null || longitude === null ? null : { latitude, longitude };
};

const usableReference = (value: string) => {
  const text = String(value || "").trim();
  if (!text || /[eE][+-]?\d+$/.test(text)) return "";
  return text;
};

const referenceFor = (record: CaseRecord) => displayIdentifier(
  usableReference(record.CrimeNo) || usableReference(record.CaseNo) || record.CaseMasterID || "Case location",
);

const pointFor = (record: CaseRecord): ChatMapPoint | null => {
  const position = coordinatesFor(record);
  if (!position) return null;
  return {
    id: String(record.CaseMasterID || record.CrimeNo || record.CaseNo || `${position.latitude},${position.longitude}`),
    label: referenceFor(record),
    station: record.PoliceStation || "Police station not recorded",
    ...position,
  };
};

const normalizedStation = (value: string) => normalize(value)
  .replace(/\bpolice\b|\bstation\b|\bps\b/g, " ")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const stationCentroid = (records: CaseRecord[], policeStation: string): ChatMapPoint | undefined => {
  const station = normalizedStation(policeStation);
  if (!station) return undefined;
  const positions = records
    .filter((record) => {
      const recordStation = normalizedStation(record.PoliceStation);
      return recordStation === station || (recordStation.length > 3 && station.length > 3 && (recordStation.includes(station) || station.includes(recordStation)));
    })
    .map(coordinatesFor)
    .filter((position): position is { latitude: number; longitude: number } => Boolean(position));
  if (!positions.length) return undefined;
  return {
    id: `station:${policeStation}`,
    label: policeStation,
    station: policeStation,
    latitude: positions.reduce((sum, item) => sum + item.latitude, 0) / positions.length,
    longitude: positions.reduce((sum, item) => sum + item.longitude, 0) / positions.length,
  };
};

const containsIdentifier = (text: string, value: string) => {
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
};

const MAP_WORTHY = /\b(case|cases|fir|crime|incident|location|where|route|navigate|directions?|reach|patrol|station|spot|scene)\b/i;
const SMALL_TALK = /^(hi|hello|hey|thanks?|thank you|ok(?:ay)?|bye|good\s*(?:morning|afternoon|evening))[\s!.,]*$/i;

// MAP_WORTHY treats the bare word "case"/"cases" as enough to consider a map,
// which means an ordinary follow-up like "give the details of complainant in
// this case" or "give me the officer details" passes that gate purely
// because it says "case" — even though the officer is asking about a person
// or a specific record field, not a place. That was attaching a route/map
// card to the reply instead of (or alongside) the actual text answer.
// This guard skips map resolution for that narrow class of question, unless
// the question also carries genuine location/navigation wording — so real
// requests like "show the route to this case's location" or "where did the
// incident happen" still get a map exactly as before.
const PERSON_OR_FIELD_DETAIL_ONLY =
  /\b(officer|complainant|accused|victim|employee\s*id|emp\s*id|chargesheet|court|acts?|sections?|gravity|status|brief\s*facts?)\b/i;
const EXPLICIT_MAP_INTENT =
  /\b(location|where|route|navigate|navigation|directions?|reach|patrol|spot|scene|map|distance|near(?:by)?|how\s*far)\b/i;

export async function resolveChatMapContext(
  question: string,
  answer: string,
  history: Array<Pick<ChatMessage, "role" | "content">>,
  policeStation: string,
): Promise<ChatMapContext | undefined> {
  if (SMALL_TALK.test(question.trim()) || !MAP_WORTHY.test(question)) return undefined;
  if (PERSON_OR_FIELD_DETAIL_ONLY.test(question) && !EXPLICIT_MAP_INTENT.test(question)) return undefined;

  try {
    const { cases } = await fetchCases();
    const allCases = cases || [];

    const lastAssistant = [...history].reverse().find((message) => message.role === "assistant")?.content || "";
    const searchable = normalize(`${question} ${answer} ${/\b(?:case|record)\s*\d+\b/i.test(question) ? lastAssistant : ""}`);
    const questionText = normalize(question);

    // Keep the separators as alternatives so Tailwind's source scanner does
    // not mistake this regular expression for an arbitrary CSS utility.
    const explicitCaseId = questionText.match(
      /\b(?:case\s*(?:master\s*)?id|id)\s*(?:-|:|#)?\s*0*(\d+)\b/i,
    )?.[1];
    const exactIdRecords = explicitCaseId
      ? allCases.filter((record) => String(Number.parseInt(record.CaseMasterID || "", 10)) === String(Number.parseInt(explicitCaseId, 10)))
      : [];
    if (explicitCaseId && exactIdRecords.length > 0 && exactIdRecords.every((record) => !coordinatesFor(record))) {
      return { destinations: [], unavailableReason: "missing_case_location" };
    }

    const geocoded = allCases.filter((record) => Boolean(coordinatesFor(record)));
    if (!geocoded.length) return undefined;
    const candidateRecords = explicitCaseId
      ? exactIdRecords.filter((record) => Boolean(coordinatesFor(record)))
      : geocoded;

    const scored = candidateRecords.map((record, index) => {
      let score = 0;
      for (const field of CASE_FIELDS) {
        const value = normalize(record[field]);
        if (!value) continue;
        if (containsIdentifier(questionText, value)) score += 120;
        else if (containsIdentifier(searchable, value)) score += 70;
      }
      for (const field of LOCATION_FIELDS) {
        const value = normalize(record[field]).replace(/\bpolice station\b/g, "").trim();
        if (value.length > 2 && questionText.includes(value)) score += field === "PoliceStation" ? 45 : 55;
      }
      return { record, score, index };
    });

    let matches = scored.filter((item) => item.score > 0);
    const ordinal = question.match(/\b(?:case|record)\s*(\d+)\b/i);
    if (ordinal && matches.length) {
      const selectedIndex = Math.max(0, Number(ordinal[1]) - 1);
      matches = [matches.sort((a, b) => b.score - a.score || a.index - b.index)[selectedIndex] || matches[0]];
    } else {
      matches.sort((a, b) => b.score - a.score || a.index - b.index);
    }

    const destinations = matches
      .slice(0, 5)
      .map(({ record }) => pointFor(record))
      .filter((point): point is ChatMapPoint => Boolean(point))
      .filter((point, index, points) => points.findIndex((candidate) => candidate.id === point.id) === index);
    if (!destinations.length) return undefined;

    return {
      destinations,
      stationOrigin: stationCentroid(allCases, policeStation),
    };
  } catch (error) {
    console.warn("Chat map context could not be resolved", error);
    return undefined;
  }
}






