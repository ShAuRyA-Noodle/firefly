type SarvamResult = { audioBytes: Uint8Array; mimeType: string };
type AlignResult = { words: string[]; wtimes: number[]; wdurations: number[] };
type GroqTtsResult = { audioBytes: Uint8Array; mimeType: string; timings: AlignResult };

const SARVAM_ENDPOINT = "https://api.sarvam.ai/text-to-speech";
const GROQ_WHISPER_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const RETRY_DELAYS_MS = [500, 1000, 2000];

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  logPrefix: string,
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!retriable) {
        const body = await res.text();
        throw new Error(`${logPrefix} HTTP ${res.status}: ${body}`);
      }
      if (attempt === RETRY_DELAYS_MS.length) {
        const body = await res.text();
        throw new Error(`${logPrefix} HTTP ${res.status} after retries: ${body}`);
      }
      const body = await res.text();
      console.warn(`${logPrefix} retriable ${res.status} (attempt ${attempt + 1}): ${body}`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    } catch (err) {
      lastErr = err;
      // Only retry on network-level failures, not on thrown 4xx errors above.
      if (err instanceof Error && err.message.includes("HTTP 4")) throw err;
      if (attempt === RETRY_DELAYS_MS.length) throw err;
      console.warn(`${logPrefix} network error (attempt ${attempt + 1}): ${String(err)}`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${logPrefix} unknown retry failure`);
}

export function splitIntoChunks(text: string, maxChars: number = 450): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  // Split on sentence boundaries while keeping the delimiter attached to the sentence.
  const sentenceRegex = /[^.!?]+[.!?]+|\S[^.!?]*$/g;
  const sentences = trimmed.match(sentenceRegex)?.map((s) => s.trim()).filter(Boolean) ?? [trimmed];

  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      const words = sentence.split(/\s+/);
      let buf = "";
      for (const w of words) {
        if ((buf + (buf ? " " : "") + w).length > maxChars) {
          if (buf) chunks.push(buf);
          buf = w.length > maxChars ? w.slice(0, maxChars) : w;
        } else {
          buf = buf ? `${buf} ${w}` : w;
        }
      }
      if (buf) current = buf;
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function concatWavBuffers(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 0) return new Uint8Array(0);
  if (buffers.length === 1) return buffers[0];

  // WAV layout: "RIFF"(4) size(4) "WAVE"(4) then chunks. We keep the full header of the first
  // buffer, append only the PCM bytes from each subsequent file's "data" chunk, then rewrite
  // the RIFF size and data-chunk size so players don't truncate playback at the first segment.
  const first = buffers[0];
  const firstDataOffset = findDataChunkOffset(first);
  const firstDataSize = readUint32LE(first, firstDataOffset + 4);
  const headerEnd = firstDataOffset + 8; // through "data" + size
  const header = first.slice(0, headerEnd);
  const firstPcm = first.slice(headerEnd, headerEnd + firstDataSize);

  const restPcm: Uint8Array[] = [];
  for (let i = 1; i < buffers.length; i++) {
    const buf = buffers[i];
    const off = findDataChunkOffset(buf);
    const size = readUint32LE(buf, off + 4);
    restPcm.push(buf.slice(off + 8, off + 8 + size));
  }

  const totalPcmSize = firstPcm.length + restPcm.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(header.length + totalPcmSize);
  out.set(header, 0);
  let cursor = header.length;
  out.set(firstPcm, cursor);
  cursor += firstPcm.length;
  for (const pcm of restPcm) {
    out.set(pcm, cursor);
    cursor += pcm.length;
  }

  // Rewrite RIFF chunk size (total file size - 8) and data chunk size.
  writeUint32LE(out, 4, out.length - 8);
  writeUint32LE(out, firstDataOffset + 4, totalPcmSize);
  return out;
}

function findDataChunkOffset(buf: Uint8Array): number {
  // Skip the 12-byte RIFF/WAVE preamble then walk chunks until we hit "data".
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
    const size = readUint32LE(buf, offset + 4);
    if (id === "data") return offset;
    offset += 8 + size;
  }
  throw new Error("WAV: data chunk not found");
}

function readUint32LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
}

function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sarvamTts(narration: string): Promise<SarvamResult> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("[Sarvam] Missing SARVAM_API_KEY");
  const model = process.env.SARVAM_TTS_MODEL ?? "bulbul:v2";
  const voice = process.env.SARVAM_VOICE ?? "anushka";
  const language = process.env.SARVAM_LANGUAGE ?? "en-IN";

  const chunks = splitIntoChunks(narration, 450);
  if (chunks.length === 0) throw new Error("[Sarvam] empty narration");
  console.log(`[Sarvam] synthesizing ${chunks.length} chunk(s), total ${narration.length} chars`);

  const buffers = await Promise.all(
    chunks.map(async (chunk, idx) => {
      const res = await fetchWithRetry(
        SARVAM_ENDPOINT,
        {
          method: "POST",
          headers: {
            "api-subscription-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            inputs: [chunk],
            target_language_code: language,
            speaker: voice,
            model,
            pitch: 0,
            pace: 1.0,
            loudness: 1.0,
            speech_sample_rate: 22050,
            enable_preprocessing: true,
          }),
        },
        "[Sarvam]",
      );
      const json = (await res.json()) as { audios?: string[]; request_id?: string };
      if (!json.audios || json.audios.length === 0) {
        throw new Error(`[Sarvam] missing audios in response (request_id=${json.request_id ?? "?"})`);
      }
      const bytes = base64ToBytes(json.audios[0]);
      console.log(`[Sarvam] chunk ${idx + 1}/${chunks.length} ok (${bytes.length} bytes)`);
      return bytes;
    }),
  );

  const merged = concatWavBuffers(buffers);
  return { audioBytes: merged, mimeType: "audio/wav" };
}

export async function groqWhisperAlign(
  audioBytes: Uint8Array,
  mimeType: string,
): Promise<AlignResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("[Whisper] Missing GROQ_API_KEY");
  const model = process.env.GROQ_WHISPER_MODEL ?? "whisper-large-v3";

  const form = new FormData();
  // Using a Blob with the WAV mime type so Whisper's auto-detection picks the right decoder.
  form.append("file", new Blob([audioBytes as BlobPart], { type: mimeType }), "audio.wav");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("language", "en");

  console.log(`[Whisper] aligning ${audioBytes.length} bytes with model ${model}`);
  const res = await fetchWithRetry(
    GROQ_WHISPER_ENDPOINT,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    },
    "[Whisper]",
  );

  const json = (await res.json()) as {
    text?: string;
    words?: Array<{ word: string; start: number; end: number }>;
  };
  if (!json.words || json.words.length === 0) {
    throw new Error(`[Whisper] response missing word timestamps: ${JSON.stringify(json).slice(0, 500)}`);
  }

  const words: string[] = [];
  const wtimes: number[] = [];
  const wdurations: number[] = [];
  for (const w of json.words) {
    words.push(w.word);
    wtimes.push(Math.round(w.start * 1000));
    wdurations.push(Math.round((w.end - w.start) * 1000));
  }
  console.log(`[Whisper] aligned ${words.length} words`);
  return { words, wtimes, wdurations };
}

export async function groqPlayAiTts(_narration: string): Promise<GroqTtsResult> {
  // Planned: POST https://api.groq.com/openai/v1/audio/speech with model "playai-tts",
  // voice param, and response_format "wav"; then run groqWhisperAlign over the returned audio.
  throw new Error("playai-tts not yet enabled");
}
