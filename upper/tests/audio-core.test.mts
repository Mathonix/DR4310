import assert from "node:assert/strict";
import test from "node:test";
import { audioCrc16, packAudioFrame, AudioFrameDecoder, AUDIO_TYPE, parseAudioStatus } from "../src/audio-protocol.ts";
import { parseAudioBytes } from "../src/audio-file.ts";
import { AudioWindow } from "../src/audio-window.ts";

test("CCITT-FALSE canonical CRC and frame roundtrip (including magic in PCM)", () => {
  assert.equal(audioCrc16(new TextEncoder().encode("123456789")), 0x29B1);
  const pcm = Uint8Array.of(0xA5,0x5A,0x0A,0x0D,0x00,0x7F);
  const packet = packAudioFrame(AUDIO_TYPE.DATA, 0x1234, 23, pcm);
  const dec = new AudioFrameDecoder();
  let got = [];
  for (const b of packet) got.push(...dec.push(Uint8Array.of(b)));
  assert.equal(got.length, 1);
  assert.equal(got[0].seq, 23); assert.equal(got[0].sid, 0x1234);
  assert.deepEqual(got[0].payload, pcm);
});

test("noise, multiple frames, damaged CRC and invalid declared length resync", () => {
  const dec = new AudioFrameDecoder();
  const valid = packAudioFrame(AUDIO_TYPE.PING, 6, 1);
  const bad = valid.slice(); bad[bad.length - 1] ^= 1;
  const length = valid.slice(); length[10] = 0xFF; length[11] = 0xFF;
  const all = Uint8Array.from([0x0,0x2, ...bad, ...length, ...valid, ...valid, ...valid]);
  const frames = dec.push(all);
  assert.equal(frames.length, 3);
  assert.equal(dec.crcErrors, 1);
  assert.ok(dec.formatErrors >= 1);
});

test("24-byte status LE decode and sid rejection", () => {
  const payload = new Uint8Array(24);
  const d = new DataView(payload.buffer);
  d.setUint32(0, 5, true); d.setUint32(4, 11, true);
  d.setUint32(8, 12345, true); d.setUint32(12, 1, true);
  d.setUint16(16, 800, true); d.setUint16(18, 0, true);
  payload[20] = 2; payload[21] = 0;
  const packet = packAudioFrame(AUDIO_TYPE.STATUS, 101, 0, payload);
  const decoded = new AudioFrameDecoder().push(packet)[0];
  assert.equal(parseAudioStatus(decoded, 101).playedSamples, 12345);
  assert.throws(() => parseAudioStatus(decoded, 102));
});

test("reject truncated/invalid RAW and nonmatching formats", () => {
  assert.throws(() => parseAudioBytes("x.raw", new Uint8Array()));
  assert.throws(() => parseAudioBytes("x.raw", Uint8Array.of(1)));
  assert.throws(() => parseAudioBytes("x.mp3", Uint8Array.of(1,2)));
});

test("20/60/300s split into 160-sample frames, only last can be short", () => {
  for (const seconds of [20, 60, 300]) {
    const data = parseAudioBytes("x.raw", new Uint8Array(seconds * 8000 * 2));
    assert.equal(data.durationSeconds, seconds);
    assert.equal(data.frames.length, seconds * 50);
    assert.ok(data.frames.every(f => f.length === 320));
  }
  const last = parseAudioBytes("x.pcm", new Uint8Array(322));
  assert.deepEqual(last.frames.map(f => f.length), [320, 2]);
});


test("ACK, exclusive grant and max six in-flight frames", () => {
  const frames = Array.from({length: 20}, () => new Uint8Array(320));
  const window = new AudioWindow(frames);
  assert.equal(window.next(0), null);
  window.status(0, 6);
  for(let seq = 0;seq < 6;seq++) assert.equal(window.next(0)?.seq, seq);
  assert.equal(window.next(0), null);
  assert.throws(() => window.status(7, 11));
  assert.equal(window.status(0, 6), false);
  assert.equal(window.status(3, 9), true);
  for (let seq = 6; seq < 9; seq++) assert.equal(window.next(1)?.seq, seq);
  assert.equal(window.next(1), null);
  assert.equal(window.status(3,9), false);
  assert.equal(window.status(2,9), false);
  assert.equal(window.ackNextSeq,3);
});

test("100ms retransmission is bounded to five retries; HALT prevents new DATA", () => {
  const window = new AudioWindow([new Uint8Array(320)]);
  window.status(0, 1);
  assert.equal(window.next(0)?.retry,false);
  for(let n = 1;n <= 5;n++) assert.equal(window.next(n*100)?.retry,true);
  assert.equal(window.retransmissions, 5);
  assert.throws(() => window.next(600), /5 次/);
  window.halt();
  assert.equal(window.next(700),null);
});
