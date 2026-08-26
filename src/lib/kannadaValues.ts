import type { Language } from "../context/LanguageContext";

const KANNADA_VALUES: Record<string, string> = {
  "Under Investigation": "ತನಿಖೆಯಲ್ಲಿದೆ",
  Registered: "ನೋಂದಾಯಿಸಲಾಗಿದೆ",
  "Charge Sheeted": "ಆರೋಪಪಟ್ಟಿ ಸಲ್ಲಿಸಲಾಗಿದೆ",
  "Charge-Sheeted": "ಆರೋಪಪಟ್ಟಿ ಸಲ್ಲಿಸಲಾಗಿದೆ",
  Closed: "ಮುಚ್ಚಲಾಗಿದೆ",
  "Closed - False Case": "ಮುಚ್ಚಲಾಗಿದೆ — ಸುಳ್ಳು ಪ್ರಕರಣ",
  "Disposed by Court": "ನ್ಯಾಯಾಲಯದಿಂದ ವಿಲೇವಾರಿ",
  Undetected: "ಪತ್ತೆಯಾಗಿಲ್ಲ",
  Pending: "ಬಾಕಿ",
  Filed: "ಸಲ್ಲಿಸಲಾಗಿದೆ",
  Submitted: "ಸಲ್ಲಿಸಲಾಗಿದೆ",
  "Pending Trial": "ವಿಚಾರಣೆ ಬಾಕಿ",
  Heinous: "ಗಂಭೀರ",
  "Non-Heinous": "ಗಂಭೀರವಲ್ಲದ",
  Theft: "ಕಳ್ಳತನ",
  "Cyber Crime": "ಸೈಬರ್ ಅಪರಾಧ",
  "Offences Against Body": "ದೇಹದ ವಿರುದ್ಧದ ಅಪರಾಧಗಳು",
  "Motor Vehicle Accident": "ಮೋಟಾರು ವಾಹನ ಅಪಘಾತ",
  Narcotics: "ಮಾದಕ ವಸ್ತುಗಳು",
  Case: "ಪ್ರಕರಣ",
  FIR: "ಎಫ್‌ಐಆರ್",
  "Police Station": "ಪೊಲೀಸ್ ಠಾಣೆ",
  "Investigating Officer (IO)": "ತನಿಖಾಧಿಕಾರಿ",
  Unknown: "ತಿಳಿದಿಲ್ಲ",
  State: "ರಾಜ್ಯ",
};

export const displayKnownValue = (value: string, language: Language) => {
  if (language !== "kn" || !value) return value;
  return KANNADA_VALUES[value.trim()] || value;
};