import type { FirRecord } from "./cases";
import { splitNames } from "./cases";

export type NetworkPerson = {
  key: string;
  name: string;
  linkedCaseKeys: string[];
};

export type NetworkCase = {
  key: string;
  record: FirRecord;
  sharedAccusedKeys: string[];
  coAccusedKeys: string[];
};

export type CriminalNetwork = {
  selected: FirRecord;
  accused: NetworkPerson[];
  relatedCases: NetworkCase[];
  coAccused: NetworkPerson[];
  repeatAccusedCount: number;
};

const NON_PERSON_VALUES = new Set([
  "-",
  "na",
  "n a",
  "nil",
  "none",
  "unknown",
  "not known",
  "unidentified",
  "not available",
  "to be ascertained",
]);

/**
 * Normalizes only typography, punctuation, case and spacing. It intentionally
 * does not perform fuzzy matching, token reordering or AI-based alias guesses.
 */
export function normalizeAccusedName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-IN")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function accusedNames(record: FirRecord): Array<{ key: string; name: string }> {
  const unique = new Map<string, string>();

  for (const name of splitNames(record.raw.AccusedNames)) {
    const key = normalizeAccusedName(name);
    const isPlaceholder =
      NON_PERSON_VALUES.has(key) ||
      /\b(?:unknown|unidentified)\b/u.test(key) ||
      /^(?:not|yet)\s+(?:known|traced|identified)$/u.test(key);
    if (!key || isPlaceholder || unique.has(key)) continue;
    unique.set(key, name.trim());
  }

  return Array.from(unique, ([key, name]) => ({ key, name })).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

function recordIdentity(record: FirRecord, index: number): string {
  // The index is only a React/layout disambiguator. It is never displayed as case data.
  return `${record.id || record.fir || record.label}::${index}`;
}

export function buildCriminalNetwork(
  selected: FirRecord,
  records: FirRecord[],
): CriminalNetwork {
  const selectedAccused = accusedNames(selected);
  const selectedKeys = new Set(selectedAccused.map((person) => person.key));
  const relatedCases: NetworkCase[] = [];
  const coAccusedNames = new Map<string, string>();

  records.forEach((record, index) => {
    if (record === selected || (selected.id && record.id === selected.id)) return;

    const people = accusedNames(record);
    const sharedAccusedKeys = people
      .filter((person) => selectedKeys.has(person.key))
      .map((person) => person.key);

    if (sharedAccusedKeys.length === 0) return;

    const coAccusedKeys = people
      .filter((person) => !selectedKeys.has(person.key))
      .map((person) => {
        if (!coAccusedNames.has(person.key)) coAccusedNames.set(person.key, person.name);
        return person.key;
      });

    relatedCases.push({
      key: recordIdentity(record, index),
      record,
      sharedAccusedKeys,
      coAccusedKeys,
    });
  });

  relatedCases.sort((a, b) => {
    const dateOrder = (b.record.date || "").localeCompare(a.record.date || "");
    return dateOrder || a.record.label.localeCompare(b.record.label);
  });

  const accused = selectedAccused.map(({ key, name }) => ({
    key,
    name,
    linkedCaseKeys: relatedCases
      .filter((relatedCase) => relatedCase.sharedAccusedKeys.includes(key))
      .map((relatedCase) => relatedCase.key),
  }));

  const coAccused = Array.from(coAccusedNames, ([key, name]) => ({
    key,
    name,
    linkedCaseKeys: relatedCases
      .filter((relatedCase) => relatedCase.coAccusedKeys.includes(key))
      .map((relatedCase) => relatedCase.key),
  })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return {
    selected,
    accused,
    relatedCases,
    coAccused,
    repeatAccusedCount: accused.filter((person) => person.linkedCaseKeys.length > 0).length,
  };
}
