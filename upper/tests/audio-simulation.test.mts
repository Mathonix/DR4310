import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { AudioFrameDecoder, AUDIO_STATE, AUDIO_TYPE, packAudioFrame } from "../src/audio-protocol.ts";
import { AudioWindow } from "../src/audio-window.ts";
import { AudioSession } from "../src/audio-session.ts";
import { parseAudioBytes } from "../src/audio-file.ts";

function fromHex(hex: string): Uint8Array { return Uint8Array.from((hex.match(/../g) ?? []).map(x => parseInt(x, 16))); }

test("frozen cross-language golden vectors match packer and decoder", () => {
  const vectors = JSON.parse(readFileSync(new URL("./protocol_vectors.json", import.meta.url), "utf8"));
  for (const item of vectors.samples) {
    const wire = fromHex(item.frame_hex);
    const frames = new AudioFrameDecoder().push(wire);
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0].payload, fromHex(item.payload_hex || ""));
    assert.deepEqual(packAudioFrame(AUDIO_TYPE[item.type as keyof typeof AUDIO_TYPE],
      item.sid, item.seq, fromHex(item.payload_hex || "")), wire, item.type);
  }
});

test("deterministic virtual 60-second link: UART budget, six-frame credit, prefill and zero underruns", () => {
  const seconds = 60;
  const samples = seconds * 8000;
  const audio = parseAudioBytes("long.raw", new Uint8Array(samples * 2));
  const window = new AudioWindow(audio.frames);
  let ack = 0, buffer = 0, played = 0, underruns = 0, started = false;
  let maxBuffer = 0, maxPending = 0, framesSent = 0;
  let tx: { seq: number; arrival: number; pcm: Uint8Array } | null = null;
  // 334 B on 230400 8N1 needs 14.50ms. Reserve 15ms per DATA, plus
  // one 5ms PING opportunity in each 100ms interval to avoid optimistic timing.
  for (let now = 0; now < 62000; now += 5) {
    if (tx && now >= tx.arrival) {
      assert.equal(tx.seq, ack, "MCU accepts only expected DATA seq");
      buffer += tx.pcm.length / 2;
      assert.ok(buffer <= 2048, "PCM ring cannot overrun");
      ack++; framesSent++;
      tx = null;
    }
    if (!started && buffer >= 800) started = true;
    if (started && played < samples) {
      if (buffer < 40) { underruns++; }
      else { buffer -= 40; played += 40; }
    }
    const grant = ack + Math.floor(Math.max(2048 - buffer - 128, 0) / 160);
    if (now % 20 === 0) window.status(ack, grant);
    maxBuffer = Math.max(maxBuffer, buffer);
    maxPending = Math.max(maxPending, window.inFlight);
    if (!tx && now % 100 !== 0) {
      const next = window.next(now);
      if (next) {
        assert.ok(next.seq < grant, "exclusive MCU grant");
        assert.ok(next.seq < window.ackNextSeq + 6, "bounded ACK window");
        tx = { seq: next.seq, arrival: now + 15, pcm: next.samples };
      }
    }
    if (played >= samples && window.completed) break;
  }
  assert.equal(underruns, 0);
  assert.equal(played, samples);
  assert.equal(framesSent, seconds * 50);
  assert.equal(maxPending <= 6, true);
  assert.equal(maxBuffer <= 2048, true);
  assert.equal(window.completed, true);
});

test("virtual MCU complete session, ACK, PAUSE, RESUME, END, FINISHED, EXIT and ASCII restoration", async () => {
  const audio = parseAudioBytes("test.raw", new Uint8Array(160 * 2 * 20));
  let session: AudioSession;
  let released: boolean | null = null;
  let ack = 0, state: number = AUDIO_STATE.BUFFERING, sid = 42, endSeen = false;
  const written: number[] = [], asciiWritten: string[] = [];
  let played = 0;
  const emit = () => {
    const payload = new Uint8Array(24), d = new DataView(payload.buffer);
    d.setUint32(0, ack, true);
    d.setUint32(4, ack + 6, true);
    d.setUint32(8, played, true);
    d.setUint16(16, state === AUDIO_STATE.EXITED ? 0 : 800, true);
    payload[20] = state;
    payload[21] = state === AUDIO_STATE.FINISHED ? 10 : 0;
    const wire = packAudioFrame(AUDIO_TYPE.STATUS, sid, 0, payload);
    queueMicrotask(() => session.onData(wire));
  };
  const mock = {
    get connected() { return true; },
    async writeText(text: string) {
      const cmd = text.trim();
      asciiWritten.push(cmd);
      queueMicrotask(() => session.onData(new TextEncoder().encode(
        cmd.startsWith("AUDIO OPEN") ?
          "@OK AUDIO OPEN v=1 sid=42 rate=8000 bits=16 cap=2048 guard=128 prefill=800 window=6\n" :
          "@OK " + cmd.split(" ")[0] + "\n")));
    },
    async writeBytes(wire: Uint8Array) {
      const f = new AudioFrameDecoder().push(wire)[0];
      assert.ok(f);
      written.push(f.type);
      if (f.type === AUDIO_TYPE.DATA) {
        assert.equal(f.seq, ack); ack++;
        if (ack >= 5 && state === AUDIO_STATE.BUFFERING) state = AUDIO_STATE.PLAYING;
        emit();
      } else if (f.type === AUDIO_TYPE.PAUSE) {
        state = AUDIO_STATE.PAUSED; emit();
      } else if (f.type === AUDIO_TYPE.RESUME) {
        state = AUDIO_STATE.PLAYING; emit();
      } else if (f.type === AUDIO_TYPE.END) {
        assert.equal(f.seq, audio.frames.length);
        assert.equal(ack, audio.frames.length);
        endSeen = true; state = AUDIO_STATE.DRAINING; emit();
        setTimeout(() => { state = AUDIO_STATE.FINISHED; played = audio.samples; emit(); }, 35);
      } else if (f.type === AUDIO_TYPE.EXIT) {
        state = AUDIO_STATE.EXITED; emit();
      } else if (f.type === AUDIO_TYPE.ABORT) {
        state = AUDIO_STATE.HALTED; emit();
      } else emit();
    },
    async abortAudio(wire: Uint8Array) { await this.writeBytes(wire); },
    async writePriorityAudioControl(wire: Uint8Array, _type: number) { await this.writeBytes(wire); },
  };
  session = new AudioSession(mock, audio, 1, () => {}, safe => { released = safe; });
  await session.start("Q", 20);
  await session.pause();
  assert.equal(session.phase, "PAUSED");
  await session.resume();
  for (let i=0;i<180 && released === null;i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(released, true);
  assert.equal(endSeen, true);
  assert.equal(session.snapshot().playedSamples, audio.samples);
  assert.ok(written.includes(AUDIO_TYPE.END));
  assert.ok(written.includes(AUDIO_TYPE.EXIT));
  assert.ok(!written.includes(AUDIO_TYPE.ABORT));
  assert.deepEqual(asciiWritten.slice(-3), ["STOP", "AE 0", "TELEM 1"]);
});
