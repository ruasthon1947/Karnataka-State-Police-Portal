import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
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

test("quota exhaustion falls back once, respects cooldown, and caches Kannada speech", async (t) => {
  const names = ["GEMINI_API_KEYS", "CATALYST_SERVICE_ACCOUNT_JSON"];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  });
  process.env.GEMINI_API_KEYS = "test-key-1,test-key-2";
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.CATALYST_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: "voice-test@example.invalid",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const calls = { gemini: 0, cloud: 0 };
  const warnings = t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      calls.gemini++;
      return { ok: false, status: 429, json: async () => ({ error: { message: "Quota exceeded. Please retry in 120s." } }) };
    }
    if (String(url).includes("oauth2.googleapis.com")) {
      return { ok: true, json: async () => ({ access_token: "test-token", expires_in: 3600 }) };
    }
    assert.match(String(url), /texttospeech.googleapis.com/);
    calls.cloud++;
    assert.equal(JSON.parse(init.body).voice.languageCode, "kn-IN");
    return { ok: true, json: async () => ({ audioContent: Buffer.from("test-audio").toString("base64") }) };
  });
  const { synthesizeNaturalSpeech } = await import("./ttsService.mjs?quota-test");
  const first = await synthesizeNaturalSpeech("ನಮಸ್ಕಾರ", "kn");
  const cached = await synthesizeNaturalSpeech("ನಮಸ್ಕಾರ", "kn");
  const next = await synthesizeNaturalSpeech("ಧನ್ಯವಾದಗಳು", "kn");
  assert.equal(first.mimeType, "audio/mpeg");
  assert.equal(next.languageCode, "kn-IN");
  assert.deepEqual(first.audio, cached.audio);
  assert.deepEqual(calls, { gemini: 1, cloud: 2 });
  assert.equal(warnings.mock.callCount(), 1);
});
