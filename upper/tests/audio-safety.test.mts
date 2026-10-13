import assert from "node:assert/strict";
import test from "node:test";
import { SerialLink } from "../src/serial.ts";
import { packAudioFrame, AUDIO_TYPE, AudioFrameDecoder } from "../src/audio-protocol.ts";

test("ABORT survives cancellation of pending DATA and repeated ordinary cancellation", async () => {
  const link = new SerialLink();
  let unlock!: () => void;
  const locked = new Promise<void>(r => { unlock = r; });
  const writes: Uint8Array[] = [];
  const mock = {
    writable: {
      getWriter() {
        return {
          async write(bytes: Uint8Array) {
            writes.push(bytes.slice());
            if (writes.length === 1) await locked;
          },
          releaseLock() {},
        };
      },
    },
  };
  Object.assign(link, { port: mock, running: true });
  const first = link.writeBytes(packAudioFrame(AUDIO_TYPE.DATA, 42, 0, new Uint8Array(320)));
  // Allow the first write to hold the writer lock.
  await new Promise<void>(r => setImmediate(r));
  const cancelled = link.writeBytes(packAudioFrame(AUDIO_TYPE.DATA, 42, 1, new Uint8Array(320)));
  const abort = link.abortAudio(packAudioFrame(AUDIO_TYPE.ABORT, 42, 0));
  link.cancelPending(); // Estop racing with an earlier stop must not cancel ABORT.
  const exit = link.writePriorityAudioControl(packAudioFrame(AUDIO_TYPE.EXIT, 42, 0), 0x05);
  link.cancelPending();
  unlock();
  await first;
  await assert.rejects(cancelled, /取消/);
  await abort; await exit;
  assert.deepEqual(writes.map(x => new AudioFrameDecoder().push(x)[0].type),
    [AUDIO_TYPE.DATA, AUDIO_TYPE.ABORT, AUDIO_TYPE.EXIT]);
});

test("binary writes reject oversized frames and priority controls reject DATA", async () => {
  const serial = new SerialLink();
  await assert.rejects(serial.writeBytes(new Uint8Array(335)), /长度/);
  await assert.rejects(serial.writePriorityAudioControl(
    packAudioFrame(AUDIO_TYPE.DATA, 1, 0, new Uint8Array(320)), 0x05), /仅允许/);
});
