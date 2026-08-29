// src/lib/speechApi.ts
//
// Client-side helper for server-side Speech-to-Text.
// Used as a fallback when the browser Web Speech API is unavailable
// (Electron, webview, non-Chrome browsers, permission-denied, etc.)

import { auth } from "../firebase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SttLanguage = "en" | "kn";

export type SttResult = {
  transcript: string;
  confidence: number;
  language: string;
};

export type SttError = {
  ok: false;
  error: string;
  status?: number;
};

// ---------------------------------------------------------------------------
// Auth header helper (same pattern as chatApi.ts)
// ---------------------------------------------------------------------------

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  try {
    const currentUser = auth.currentUser;
    if (currentUser) {
      const token = await currentUser.getIdToken();
      headers["Authorization"] = `Bearer ${token}`;
    }
  } catch {
    // Proceed without auth header — the session cookie may still work.
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Audio capture — records a short clip from the microphone using MediaRecorder
// ---------------------------------------------------------------------------

/**
 * Capture audio from the microphone for `maxDurationMs` milliseconds
 * and return it as a base64-encoded string along with the MIME type.
 *
 * Returns null if the microphone is unavailable or the user denies permission.
 */
export async function captureAudio(
  maxDurationMs = 10_000,
): Promise<{ audio: string; mimeType: string } | null> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return null;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000,
      },
    });
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    // Pick the best supported MIME type
    const mimeType =
      MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/ogg";

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      resolve(null);
      return;
    }

    const chunks: Blob[] = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());

      if (chunks.length === 0) {
        resolve(null);
        return;
      }

      const blob = new Blob(chunks, { type: mimeType });
      const arrayBuffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]);
      }
      const audio = btoa(binary);
      resolve({ audio, mimeType });
    };

    recorder.start(250); // collect in 250ms chunks

    setTimeout(() => {
      if (recorder.state === "recording") {
        recorder.stop();
      }
    }, maxDurationMs);
  });
}

// ---------------------------------------------------------------------------
// Server STT API
// ---------------------------------------------------------------------------

/**
 * Send captured audio to the server for transcription via Google Cloud Speech.
 *
 * @param audio   Base64-encoded audio data
 * @param lang    Language hint: "en" or "kn"
 * @param mimeType  MIME type of the audio (e.g. "audio/webm;codecs=opus")
 */
export async function transcribeAudio(
  audio: string,
  lang: SttLanguage = "en",
  mimeType = "audio/webm",
): Promise<SttResult> {
  const headers = await getAuthHeaders();

  const res = await fetch("/api/speech-to-text", {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ audio, lang, mimeType }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || !data?.ok) {
    const serverMessage = data?.error || `HTTP ${res.status}`;
    console.error("[STT] Server error:", serverMessage);
    throw new Error(serverMessage);
  }

  return {
    transcript: data.transcript || "",
    confidence: typeof data.confidence === "number" ? data.confidence : 0,
    language: data.language || lang,
  };
}

/**
 * Convenience: capture audio from mic + send to server STT in one call.
 * Returns the transcript or null if anything went wrong.
 */
export async function listenViaServer(
  lang: SttLanguage = "en",
  maxDurationMs = 10_000,
): Promise<SttResult> {
  const captured = await captureAudio(maxDurationMs);
  if (!captured) {
    throw new Error("Microphone is not available. Please allow microphone access.");
  }

  return transcribeAudio(captured.audio, lang, captured.mimeType);
}

// ---------------------------------------------------------------------------
// Streaming STT — real-time captions via PCM → WAV chunked recording
// ---------------------------------------------------------------------------

/**
 * Encode Float32 PCM samples as a 16-bit mono WAV ArrayBuffer.
 */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numSamples = samples.length;
  const bytesPerSample = 2; // 16-bit
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);       // PCM chunk size
  view.setUint16(20, 1, true);        // PCM format
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);       // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  // Write PCM samples as 16-bit integers
  let offset = 44;
  for (let i = 0; i < numSamples; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s * 32767, true);
  }

  return buffer;
}

/**
 * Convert an ArrayBuffer to base64.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Start streaming STT: captures raw PCM via Web Audio API, encodes as WAV,
 * sends chunks to the server every ~2 seconds for real-time captions.
 *
 * WAV is always valid — no malformed container issues like WebM chunks.
 */
export function startStreamingSTT(
  lang: SttLanguage = "en",
  onTranscript: (text: string, isFinal: boolean) => void,
  onError: (error: string) => void,
): { stop: (discard?: boolean) => void } {
  let stopped = false;
  let stopping = false;
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let silentGain: GainNode | null = null;
  let chunkTimer: ReturnType<typeof setInterval> | null = null;
  let accumulatedTranscript = "";
  let sendingChunk = false;
  let pendingSamples: Float32Array[] = [];
  let pendingSampleCount = 0;
  let lastSend: Promise<void> = Promise.resolve();
  let retryAfter = 0;

  // Keep each WAV request small even when the transcription service is slow.
  const CHUNK_SECONDS = 5;

  const cleanup = () => {
    if (chunkTimer) { clearInterval(chunkTimer); chunkTimer = null; }
    processor?.disconnect();
    source?.disconnect();
    silentGain?.disconnect();
    processor = null;
    source = null;
    silentGain = null;
    void audioContext?.close();
    audioContext = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    pendingSamples = [];
    pendingSampleCount = 0;
  };

  /** Efficient base64 encoding using chunked Uint8Array conversion. */
  const bufferToBase64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    const CHUNK = 8192;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(binary);
  };

  const sendChunk = async (allowStopping = false) => {
    if (pendingSampleCount === 0 || sendingChunk || stopped && !allowStopping || Date.now() < retryAfter) return;
    sendingChunk = true;

    const samples = pendingSamples;
    const sampleCount = pendingSampleCount;
    pendingSamples = [];
    pendingSampleCount = 0;

    try {
      const combined = new Float32Array(sampleCount);
      let offset = 0;
      for (const part of samples) {
        combined.set(part, offset);
        offset += part.length;
      }
      let energy = 0;
      for (let i = 0; i < combined.length; i += 1) energy += combined[i] * combined[i];
      if (Math.sqrt(energy / combined.length) < 0.006) {
        sendingChunk = false;
        return;
      }
      const sampleRate = audioContext?.sampleRate || 48000;
      const arrayBuffer = encodeWav(combined, sampleRate);
      const audio = bufferToBase64(arrayBuffer);
      const result = await transcribeAudio(audio, lang, "audio/wav");
      if (result.transcript.trim()) {
        accumulatedTranscript += (accumulatedTranscript ? " " : "") + result.transcript.trim();
        onTranscript(accumulatedTranscript, false);
      }
    } catch (err) {
      console.warn("[StreamingSTT] Chunk failed:", err);
      if (String(err).includes("Too many requests") || String(err).includes("429")) {
        retryAfter = Date.now() + 10_000;
      }
      if (!stopped) onError("Live captions are unavailable. Check the speech service and try again.");
    } finally {
      sendingChunk = false;
      // Drain samples captured while the previous request was in flight.
      if (!stopped && pendingSampleCount > 0) {
        lastSend = sendChunk();
      }
    }
  };

  const start = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000,
        },
      });
    } catch {
      onError("Microphone is not available. Please allow microphone access.");
      return;
    }

    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    try {
      audioContext = new AudioContextCtor();
      if (audioContext.state === "suspended") await audioContext.resume();
      if (audioContext.state !== "running") {
        throw new Error("Audio context did not start");
      }
      source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      processor.onaudioprocess = (event) => {
        if (stopped) return;
        const input = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input);
        pendingSamples.push(copy);
        pendingSampleCount += copy.length;
      };
      source.connect(processor);
      // Keep ScriptProcessor callbacks alive without playing the microphone
      // back through the speakers.
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
    } catch {
      cleanup();
      onError("Audio recording is not supported in this browser.");
      return;
    }

    console.log("[StreamingSTT] Started PCM recording");

    // Send chunk every N seconds for real-time captions
    chunkTimer = setInterval(() => {
      lastSend = sendChunk();
    }, CHUNK_SECONDS * 1000);
  };

  void start();

  return {
    stop: (discard = false) => {
      if (stopped || stopping) return;
      stopping = true;
      processor?.disconnect();
      void lastSend.then(() => sendChunk(true)).then(() => {
        stopped = true;
        if (!discard) onTranscript(accumulatedTranscript, true);
        cleanup();
      });
    },
  };
}
