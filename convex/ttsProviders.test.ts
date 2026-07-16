/// <reference types="vite/client" />
import { describe, test, expect } from "vitest";
import { splitIntoChunks, concatWavBuffers } from "./ttsProviders";

describe("splitIntoChunks", () => {
  test("returns empty array for empty input", () => {
    expect(splitIntoChunks("")).toEqual([]);
    expect(splitIntoChunks("   ")).toEqual([]);
  });

  test("returns single chunk when under limit", () => {
    const text = "Short sentence.";
    expect(splitIntoChunks(text, 450)).toEqual([text]);
  });

  test("splits on sentence boundary", () => {
    const text =
      "First sentence is short. Second sentence is also short. Third sentence here.";
    const chunks = splitIntoChunks(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  test("handles extremely long single sentence by word-splitting", () => {
    const longWord = "word ".repeat(200).trim();
    const chunks = splitIntoChunks(longWord, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50);
  });

  test("preserves sentence-ending punctuation", () => {
    const chunks = splitIntoChunks("Hi! How are you? I am fine.", 100);
    expect(chunks.join(" ")).toContain("!");
    expect(chunks.join(" ")).toContain("?");
    expect(chunks.join(" ")).toContain(".");
  });
});

describe("concatWavBuffers", () => {
  // Build a minimal valid WAV header + N bytes of PCM data.
  function makeWav(pcmLen: number): Uint8Array {
    const totalSize = 44 + pcmLen;
    const buf = new Uint8Array(totalSize);
    // "RIFF"
    buf[0] = 82; buf[1] = 73; buf[2] = 70; buf[3] = 70;
    // file size - 8 (little-endian uint32)
    const riffSize = totalSize - 8;
    buf[4] = riffSize & 0xff;
    buf[5] = (riffSize >>> 8) & 0xff;
    buf[6] = (riffSize >>> 16) & 0xff;
    buf[7] = (riffSize >>> 24) & 0xff;
    // "WAVE"
    buf[8] = 87; buf[9] = 65; buf[10] = 86; buf[11] = 69;
    // "fmt "
    buf[12] = 102; buf[13] = 109; buf[14] = 116; buf[15] = 32;
    // fmt chunk size (16 for PCM)
    buf[16] = 16;
    // everything else in fmt chunk: zeros is fine for our header-walker test
    // "data"
    buf[36] = 100; buf[37] = 97; buf[38] = 116; buf[39] = 97;
    // data chunk size
    buf[40] = pcmLen & 0xff;
    buf[41] = (pcmLen >>> 8) & 0xff;
    buf[42] = (pcmLen >>> 16) & 0xff;
    buf[43] = (pcmLen >>> 24) & 0xff;
    // Fill PCM with a recognizable byte pattern so we can verify placement.
    for (let i = 0; i < pcmLen; i++) buf[44 + i] = (i + 1) & 0xff;
    return buf;
  }

  test("returns input unchanged for single buffer", () => {
    const wav = makeWav(100);
    const out = concatWavBuffers([wav]);
    expect(out).toBe(wav);
  });

  test("returns empty Uint8Array for empty input", () => {
    const out = concatWavBuffers([]);
    expect(out.length).toBe(0);
  });

  test("concatenates two WAV buffers preserving header and PCM order", () => {
    const a = makeWav(10);
    const b = makeWav(20);
    const out = concatWavBuffers([a, b]);
    // Total size should be first full header + sum of PCM bytes
    expect(out.length).toBe(44 + 10 + 20);
    // Header comes from the first buffer
    expect(out[0]).toBe(82); // R
    expect(out[8]).toBe(87); // W
    // PCM data starts after the first header (offset 44)
    // a's PCM was 1..10, b's PCM was 1..20
    expect(out[44]).toBe(1);
    expect(out[53]).toBe(10);
    // Right after a's 10 bytes, b's 20 bytes begin
    expect(out[54]).toBe(1);
    expect(out[73]).toBe(20);
  });

  test("rewrites RIFF + data chunk sizes to reflect merged content", () => {
    const a = makeWav(10);
    const b = makeWav(20);
    const out = concatWavBuffers([a, b]);
    const readU32 = (o: number) =>
      out[o] | (out[o + 1] << 8) | (out[o + 2] << 16) | (out[o + 3] << 24);
    // RIFF size = total - 8
    expect(readU32(4)).toBe(out.length - 8);
    // data chunk size = total PCM bytes
    expect(readU32(40)).toBe(30);
  });
});
