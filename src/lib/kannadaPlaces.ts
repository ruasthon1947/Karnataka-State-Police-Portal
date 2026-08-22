import type { Language } from "../context/LanguageContext";

const KNOWN_PLACES: Record<string, string> = {
  bengaluru: "ಬೆಂಗಳೂರು",
  bangalore: "ಬೆಂಗಳೂರು",
  whitefield: "ವೈಟ್‌ಫೀಲ್ಡ್",
  indiranagar: "ಇಂದಿರಾನಗರ",
  yelahanka: "ಯಲಹಂಕ",
  upparpet: "ಉಪ್ಪಾರಪೇಟೆ",
  majestic: "ಮೆಜೆಸ್ಟಿಕ್",
  jayanagar: "ಜಯನಗರ",
  "electronic city": "ಎಲೆಕ್ಟ್ರಾನಿಕ್ ಸಿಟಿ",
  koramangala: "ಕೋರಮಂಗಲ",
  "hsr layout": "ಎಚ್‌ಎಸ್‌ಆರ್ ಬಡಾವಣೆ",
  hebbal: "ಹೆಬ್ಬಾಳ",
  marathahalli: "ಮಾರತಹಳ್ಳಿ",
  banashankari: "ಬನಶಂಕರಿ",
  malleswaram: "ಮಲ್ಲೇಶ್ವರಂ",
  malleshwaram: "ಮಲ್ಲೇಶ್ವರಂ",
  rajajinagar: "ರಾಜಾಜಿನಗರ",
  vijayanagar: "ವಿಜಯನಗರ",
  basavanagudi: "ಬಸವನಗುಡಿ",
  shivajinagar: "ಶಿವಾಜಿನಗರ",
  kengeri: "ಕೆಂಗೇರಿ",
  peenya: "ಪೀಣ್ಯ",
  "kr puram": "ಕೆ.ಆರ್. ಪುರಂ",
  "k r puram": "ಕೆ.ಆರ್. ಪುರಂ",
  bellandur: "ಬೆಳ್ಳಂದೂರು",
  sarjapur: "ಸರ್ಜಾಪುರ",
  hennur: "ಹೆಣ್ಣೂರು",
  banaswadi: "ಬಾಣಸವಾಡಿ",
  "jp nagar": "ಜೆ.ಪಿ. ನಗರ",
  "j p nagar": "ಜೆ.ಪಿ. ನಗರ",
  chamarajpet: "ಚಾಮರಾಜಪೇಟೆ",
  chickpet: "ಚಿಕ್ಕಪೇಟೆ",
  "cubbon park": "ಕಬ್ಬನ್ ಪಾರ್ಕ್",
  "mg road": "ಎಂ.ಜಿ. ರಸ್ತೆ",
  "m g road": "ಎಂ.ಜಿ. ರಸ್ತೆ",
  halasuru: "ಹಲಸೂರು",
  ulsoor: "ಹಲಸೂರು",
  mahadevapura: "ಮಹದೇವಪುರ",
  bommanahalli: "ಬೊಮ್ಮನಹಳ್ಳಿ",
  kamakshipalya: "ಕಾಮಾಕ್ಷಿಪಾಳ್ಯ",
  byatarayanapura: "ಬ್ಯಾಟರಾಯನಪುರ",
  "wilson garden": "ವಿಲ್ಸನ್ ಗಾರ್ಡನ್",
  "ashok nagar": "ಅಶೋಕ ನಗರ",
  "high grounds": "ಹೈ ಗ್ರೌಂಡ್ಸ್",
  seshadripuram: "ಶೇಷಾದ್ರಿಪುರಂ",
  subramanyapura: "ಸುಬ್ರಹ್ಮಣ್ಯಪುರ",
  "rt nagar": "ಆರ್.ಟಿ. ನಗರ",
  "r t nagar": "ಆರ್.ಟಿ. ನಗರ",
  sadashivanagar: "ಸದಾಶಿವನಗರ",
  richmond: "ರಿಚ್ಮಂಡ್",
  brigade: "ಬ್ರಿಗೇಡ್",
  domlur: "ದೊಮ್ಮಲೂರು",
  devanahalli: "ದೇವನಹಳ್ಳಿ",
  nelamangala: "ನೆಲಮಂಗಲ",
  anekal: "ಆನೇಕಲ್",
  hosakote: "ಹೊಸಕೋಟೆ",
};

const KNOWN_TERMS: Record<string, string> = {
  "police station": "ಪೊಲೀಸ್ ಠಾಣೆ",
  "traffic police station": "ಸಂಚಾರ ಪೊಲೀಸ್ ಠಾಣೆ",
  station: "ಠಾಣೆ",
  police: "ಪೊಲೀಸ್",
  road: "ರಸ್ತೆ",
  main: "ಮುಖ್ಯ",
  cross: "ಕ್ರಾಸ್",
  layout: "ಬಡಾವಣೆ",
  extension: "ವಿಸ್ತರಣೆ",
  nagar: "ನಗರ",
  area: "ಪ್ರದೇಶ",
  village: "ಗ್ರಾಮ",
  town: "ಪಟ್ಟಣ",
  colony: "ಕಾಲೋನಿ",
  phase: "ಹಂತ",
  stage: "ಹಂತ",
  ward: "ವಾರ್ಡ್",
  district: "ಜಿಲ್ಲೆ",
  zone: "ವಲಯ",
  corridor: "ಕಾರಿಡಾರ್",
  city: "ನಗರ",
  market: "ಮಾರುಕಟ್ಟೆ",
  circle: "ವೃತ್ತ",
  junction: "ಜಂಕ್ಷನ್",
  "bus stand": "ಬಸ್ ನಿಲ್ದಾಣ",
  "railway station": "ರೈಲು ನಿಲ್ದಾಣ",
  "metro station": "ಮೆಟ್ರೋ ನಿಲ್ದಾಣ",
  hospital: "ಆಸ್ಪತ್ರೆ",
  street: "ಬೀದಿ",
  avenue: "ಅವೆನ್ಯೂ",
  feet: "ಅಡಿ",
  tech: "ಟೆಕ್",
  park: "ಪಾರ್ಕ್",
  near: "ಹತ್ತಿರ",
};

const INDEPENDENT_VOWELS: Record<string, string> = {
  a: "ಅ", aa: "ಆ", i: "ಇ", ee: "ಈ", ii: "ಈ", u: "ಉ", oo: "ಊ", uu: "ಊ",
  e: "ಎ", ai: "ಐ", o: "ಒ", au: "ಔ",
};

const VOWEL_SIGNS: Record<string, string> = {
  a: "", aa: "ಾ", i: "ಿ", ee: "ೀ", ii: "ೀ", u: "ು", oo: "ೂ", uu: "ೂ",
  e: "ೆ", ai: "ೈ", o: "ೊ", au: "ೌ",
};

const CONSONANTS: Record<string, string> = {
  ksh: "ಕ್ಷ", kh: "ಖ", gh: "ಘ", ch: "ಚ", jh: "ಝ", th: "ಥ", dh: "ಧ", ph: "ಫ", bh: "ಭ",
  sh: "ಶ", ng: "ಙ", ny: "ಞ", tr: "ತ್ರ", dr: "ದ್ರ",
  k: "ಕ", g: "ಗ", c: "ಕ", j: "ಜ", t: "ತ", d: "ದ", n: "ನ", p: "ಪ", b: "ಬ", m: "ಮ",
  y: "ಯ", r: "ರ", l: "ಲ", v: "ವ", w: "ವ", s: "ಸ", h: "ಹ", f: "ಫ", q: "ಕ", x: "ಕ್ಸ", z: "ಜ",
};

const vowelAt = (value: string, index: number) => {
  for (const vowel of ["aa", "ee", "ii", "oo", "uu", "ai", "au", "a", "i", "u", "e", "o"]) {
    if (value.startsWith(vowel, index)) return vowel;
  }
  return "";
};

const consonantAt = (value: string, index: number) => {
  for (const consonant of ["ksh", "kh", "gh", "ch", "jh", "th", "dh", "ph", "bh", "sh", "ng", "ny", "tr", "dr"]) {
    if (value.startsWith(consonant, index)) return consonant;
  }
  return CONSONANTS[value[index]] ? value[index] : "";
};

const transliterateToken = (token: string) => {
  const lower = token.toLowerCase();
  if (!/[a-z]/.test(lower)) return token;
  let result = "";
  let index = 0;
  while (index < lower.length) {
    const character = lower[index];
    if (!/[a-z]/.test(character)) {
      result += character;
      index += 1;
      continue;
    }
    const initialVowel = vowelAt(lower, index);
    if (initialVowel) {
      result += INDEPENDENT_VOWELS[initialVowel];
      index += initialVowel.length;
      continue;
    }
    const consonant = consonantAt(lower, index);
    if (!consonant) {
      result += character;
      index += 1;
      continue;
    }
    result += CONSONANTS[consonant];
    index += consonant.length;
    const vowel = vowelAt(lower, index);
    if (vowel) {
      result += VOWEL_SIGNS[vowel];
      index += vowel.length;
    } else if (index < lower.length && /[a-z]/.test(lower[index])) {
      result += "್";
    } else if (index >= lower.length) {
      result += "್";
    }
  }
  return result;
};

const phraseEntries = [...Object.entries(KNOWN_PLACES), ...Object.entries(KNOWN_TERMS)]
  .sort(([left], [right]) => right.length - left.length);

export const toKannadaPlaceName = (value: string) => {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  if (!normalized || /[\u0C80-\u0CFF]/.test(normalized)) return normalized;
  let remaining = normalized.toLowerCase();
  const protectedValues = new Map<string, string>();
  let protectedIndex = 0;
  for (const [phrase, kannada] of phraseEntries) {
    const pattern = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    remaining = remaining.replace(pattern, () => {
      const marker = `§${protectedIndex}§`;
      protectedValues.set(marker, kannada);
      protectedIndex += 1;
      return marker;
    });
  }
  const transliterated = remaining
    .split(/(§\d+§|\s+|[^a-z0-9§]+)/i)
    .map((part) => protectedValues.get(part) || (/^[a-z]+$/i.test(part) ? transliterateToken(part) : part))
    .join("");
  return transliterated.replace(/\s+/g, " ").trim();
};

export const displayPlaceName = (value: string, language: Language) =>
  language === "kn" ? toKannadaPlaceName(value) : value;
