import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import ttsPlugin, { handleTtsRequest } from "./ttsPlugin.mjs";
import { createSessionToken } from "./security.mjs";

test("dev and production startup never synthesize greetings, even with legacy prewarm enabled", async (t) => {
  const prior = process.env.TTS_PREWARM;
  process.env.TTS_PREWARM = "true";
  t.after(() => {
    if (prior === undefined) delete process.env.TTS_PREWARM;
    else process.env.TTS_PREWARM = prior;
  });
  const requests = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Startup must never call a speech provider");
  });
  const timers = t.mock.method(globalThis, "setTimeout", () => ({ unref() {} }));
  const handlers = [];
  const server = { middlewares: { use: (handler) => handlers.push(handler) } };
  const plugin = ttsPlugin();
  plugin.configureServer(server);
  plugin.configurePreviewServer(server);
  await new Promise(setImmediate);
  assert.equal(requests.mock.callCount(), 0);
  assert.equal(timers.mock.callCount(), 0);
  assert.deepEqual(handlers, [handleTtsRequest, handleTtsRequest]);
});

test("voice endpoint rejects anonymous requests and returns audio on explicit authenticated playback", async (t) => {
  const oldKeys = process.env.GEMINI_API_KEYS;
  process.env.GEMINI_API_KEYS = "test-key";
  t.after(() => {
    if (oldKeys === undefined) delete process.env.GEMINI_API_KEYS;
    else process.env.GEMINI_API_KEYS = oldKeys;
  });
  const requests = t.mock.method(globalThis, "fetch", async (_url, init) => {
    const payload = JSON.parse(init.body);
    assert.equal(payload.generation_config.speech_config[0].language, "kn-IN");
    assert.match(payload.input, /ನಮಸ್ಕಾರ/);
    return { ok: true, json: async () => ({ steps: [{ content: [{ type: "audio", data: Buffer.alloc(480).toString("base64"), sample_rate: 24000 }] }] }) };
  });
  const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } });
  const anonymous = response();
  await handleTtsRequest({ method: "POST", url: "/api/text-to-speech", headers: {} }, anonymous, () => assert.fail("Unexpected fallthrough"));
  assert.equal(anonymous.statusCode, 401);
  assert.equal(requests.mock.callCount(), 0);
  const session = createSessionToken({ employeeId: "voice-test", name: "Test Officer", role: "Inspector", policeStation: "Test Station" });
  const req = Readable.from([JSON.stringify({ text: "ನಮಸ್ಕಾರ", language: "kn" })]);
  Object.assign(req, { method: "POST", url: "/api/text-to-speech", headers: { cookie: `kspp_session=${session.token}` } });
  const res = response();
  await handleTtsRequest(req, res, () => assert.fail("Unexpected fallthrough"));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "audio/wav");
  assert.equal(res.headers["X-KSPP-Language"], "kn-IN");
  assert.equal(res.body.subarray(0, 4).toString(), "RIFF");
  assert.equal(requests.mock.callCount(), 1);
});
