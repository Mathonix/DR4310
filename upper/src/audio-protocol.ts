/** AUDIO V1 wire primitives. Numeric STATUS state/reason meanings require the frozen 00 spec. */
export const AUDIO_MAGIC_0 = 0xA5;
export const AUDIO_MAGIC_1 = 0x5A;
export const AUDIO_VERSION = 1;
export const AUDIO_HEADER_SIZE = 12;
export const AUDIO_MAX_PAYLOAD = 320;
export const AUDIO_MAX_FRAME_SIZE = 334;

export const AUDIO_STATE = { BUFFERING: 0, PLAYING: 1, PAUSED: 2, DRAINING: 3, FINISHED: 4, HALTED: 5, FAULT: 6, EXITED: 7 } as const;
export const AUDIO_REASON = { OK: 0, CRC_ERROR: 1, SEQ_GAP: 2, BUFFER_FULL: 3, PROTOCOL_ERROR: 4,
  TIMEOUT: 5, UNDERRUN: 6, CANCELLED: 7, SAFETY_FAULT: 8, MODE_CHANGED: 9, ENDED: 10, SESSION_MISMATCH: 11 } as const;
export const AUDIO_TYPE = {
  DATA: 0x01, END: 0x02, ABORT: 0x03, PING: 0x04,
  EXIT: 0x05, PAUSE: 0x06, RESUME: 0x07, STATUS: 0x81,
} as const;
export type AudioFrame = { type: number; sid: number; seq: number; payload: Uint8Array };
export type AudioStatus = {
  ackNextSeq: number; grantSeqExclusive: number; playedSamples: number; underrunCount: number;
  bufferSamples: number; faultFlags: number; stateCode: number; reasonCode: number; reserved: number;
};

/** CRC-16/CCITT-FALSE: init FFFF, poly 1021, no xorout/reflection. */
export function audioCrc16(data: Uint8Array): number {
  let crc = 0xFFFF;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? (crc << 1 ^ 0x1021) & 0xFFFF : crc << 1 & 0xFFFF;
  }
  return crc;
}

export function packAudioFrame(type: number, sid: number, seq: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  if (!Number.isInteger(type) || type < 0 || type > 255 ||
      !Number.isInteger(sid) || sid < 0 || sid > 65535 ||
      !Number.isInteger(seq) || seq < 0 || seq > 0xFFFFFFFF ||
      payload.length > AUDIO_MAX_PAYLOAD)
    throw new Error("非法 AUDIO 帧参数");
  if (type === AUDIO_TYPE.DATA && (payload.length === 0 || (payload.length & 1)))
    throw new Error("DATA payload 必须是非空的 s16le 样本");
  const result = new Uint8Array(AUDIO_HEADER_SIZE + payload.length + 2);
  result[0] = AUDIO_MAGIC_0; result[1] = AUDIO_MAGIC_1;
  const view = new DataView(result.buffer);
  result[2] = AUDIO_VERSION; result[3] = type;
  view.setUint16(4, sid, true);
  view.setUint32(6, seq, true);
  view.setUint16(10, payload.length, true);
  result.set(payload, AUDIO_HEADER_SIZE);
  view.setUint16(result.length - 2, audioCrc16(result.subarray(2, result.length - 2)), true);
  return result;
}

export function parseAudioStatus(frame: AudioFrame, sid: number): AudioStatus {
  if (frame.type !== AUDIO_TYPE.STATUS || frame.sid !== sid || frame.payload.length !== 24 || sid === 0)
    throw new Error("STATUS 类型、sid 或长度错误");
  const d = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
  const stateCode = d.getUint8(20), reasonCode = d.getUint8(21);
  if (stateCode > AUDIO_STATE.EXITED || reasonCode > AUDIO_REASON.SESSION_MISMATCH || d.getUint16(22, true) !== 0)
    throw new Error("STATUS 状态码、原因码或保留位非法");
  return {
    ackNextSeq: d.getUint32(0, true), grantSeqExclusive: d.getUint32(4, true),
    playedSamples: d.getUint32(8, true), underrunCount: d.getUint32(12, true),
    bufferSamples: d.getUint16(16, true), faultFlags: d.getUint16(18, true),
    stateCode, reasonCode, reserved: 0,
  };
}

/** Handles byte-split, noise, multiple frames and malformed lengths; never assumes read boundaries. */
export class AudioFrameDecoder {
  private pending: number[] = [];
  crcErrors = 0;
  formatErrors = 0;
  reset(): void { this.pending = []; this.crcErrors = 0; this.formatErrors = 0; }

  push(bytes: Uint8Array): AudioFrame[] {
    const frames: AudioFrame[] = [];
    for (const b of bytes) this.pending.push(b);
    for (;;) {
      let start = 0;
      while (start + 1 < this.pending.length &&
        (this.pending[start] !== AUDIO_MAGIC_0 || this.pending[start + 1] !== AUDIO_MAGIC_1)) start++;
      if (start) this.pending.splice(0, start);
      if (this.pending.length < 2) break;
      if (this.pending.length < AUDIO_HEADER_SIZE) break;
      const version = this.pending[2]!;
      const len = this.pending[10]! | this.pending[11]! << 8;
      const type = this.pending[3]!;
      if (version !== AUDIO_VERSION || len > AUDIO_MAX_PAYLOAD || !Object.values(AUDIO_TYPE).includes(type as typeof AUDIO_TYPE[keyof typeof AUDIO_TYPE]) || (type === AUDIO_TYPE.DATA && (len === 0 || !!(len & 1))) || (type === AUDIO_TYPE.STATUS && len !== 24) || (type !== AUDIO_TYPE.DATA && type !== AUDIO_TYPE.STATUS && len !== 0)) {
        this.formatErrors++; this.pending.shift(); continue;
      }
      const size = AUDIO_HEADER_SIZE + len + 2;
      if (this.pending.length < size) break;
      const packet = Uint8Array.from(this.pending.slice(0, size));
      const view = new DataView(packet.buffer);
      const expected = view.getUint16(size - 2, true);
      if (audioCrc16(packet.subarray(2, size - 2)) !== expected) {
        this.crcErrors++; this.pending.shift(); continue;
      }
      frames.push({ type: packet[3]!, sid: view.getUint16(4, true),
        seq: view.getUint32(6, true), payload: packet.subarray(AUDIO_HEADER_SIZE, size - 2) });
      this.pending.splice(0, size);
    }
    // Preserve a single possible prefix byte, not unbounded garbage.
    if (this.pending.length === 1 && this.pending[0] !== AUDIO_MAGIC_0) this.pending = [];
    return frames;
  }
}
