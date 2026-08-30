import assert from "node:assert/strict";
import test from "node:test";
import { buildSpeechSsml, pcmToWav, sanitizeSpeechText } from "./ttsService.mjs";

test("cleans visual formatting without removing Kannada speech", () => {
  assert.equal(
    sanitizeSpeechText("📌 **ಪ್ರಕರಣ:** CR-1/2026\n- ಸ್ಥಿತಿ: ತನಿಖೆಯಲ್ಲಿದೆ"),
    "ಪ್ರಕರಣ: CR-1/2026. ಸ್ಥಿತಿ: ತನಿಖೆಯಲ್ಲಿದೆ",
  );
});

test("adds a natural pause between complete sentences and escapes SSML", () => {
  const ssml = buildSpeechSsml("The case is open. Ask R&D for the file.");
  assert.match(ssml, /^<speak>/);
  assert.match(ssml, /<break time="240ms"\/>/);
  assert.match(ssml, /R&amp;D/);
  assert.match(ssml, /<s>The case is open\.<\/s>/);
});

test("wraps Gemini PCM output in a browser-decodable WAV container", () => {
  const wav = pcmToWav(Buffer.alloc(480), 24_000, 1);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(40), 480);
});
