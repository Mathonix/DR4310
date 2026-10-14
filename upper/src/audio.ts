import { AudioType, decodeAudioFrame, encodeAudioFrame } from "../../protocol/audio_uart_v1";

export type AudioStatus = { ack: number; grant: number; played: number; underruns: number; buffer: number; faults: number; state: number; reason: number };
export const AUDIO_STATES = ["预缓冲", "播放中", "已暂停", "播放尾段", "已完成", "已中止", "安全故障", "已退出"];
export const AUDIO_REASONS = ["正常", "CRC 错误", "序号缺口", "缓冲已满", "接收/协议错误", "通信超时", "音频欠载", "已取消", "安全互锁", "控制模式改变", "播放结束", "会话不匹配"];
export const audioReason = (s: AudioStatus): string => s.reason === 0 && s.underruns ? "音频欠载" : s.reason === 0 && (s.state === 5 || s.state === 6) ? "中止原因未收到" : AUDIO_REASONS[s.reason] ?? "未知原因";
/** Absent capability means the frozen V1 200 mA limit. */
export const AUDIO_MAX_AMPLITUDE_MA = { Q: 2000, D: 1500 } as const;
export function audioAmplitudeMax(axis: "Q" | "D", advertised?: number): number {
  const ceiling = AUDIO_MAX_AMPLITUDE_MA[axis];
  return Number.isInteger(advertised) && advertised! >= 1 && advertised! <= ceiling ? advertised! : 200;
}

/** Bounded decoder: recover at the next sync after bad CRC or a missing tail. */
export class AudioStatusParser {
  private bytes: number[] = [];
  rejected = 0;
  push(chunk: Uint8Array): { sid: number; status: AudioStatus }[] {
    const out: { sid: number; status: AudioStatus }[] = [];
    for (const byte of chunk) {
      this.bytes.push(byte);
      while (this.bytes.length >= 2) {
        if (this.bytes[0] !== 0xa5 || this.bytes[1] !== 0x5a) { this.bytes.shift(); continue; }
        if (this.bytes.length < 12) break;
        const n = this.bytes[10]! | this.bytes[11]! << 8;
        if (n !== 24 || this.bytes[2] !== 1 || this.bytes[3] !== AudioType.STATUS) { this.rejected++; this.bytes.shift(); continue; }
        if (this.bytes.length < 38) break;
        try {
          const frame = decodeAudioFrame(new Uint8Array(this.bytes.slice(0, 38)));
          const d = new DataView(frame.payload.buffer, frame.payload.byteOffset, 24);
          out.push({ sid: frame.sid, status: { ack: d.getUint32(0, true), grant: d.getUint32(4, true), played: d.getUint32(8, true), underruns: d.getUint32(12, true), buffer: d.getUint16(16, true), faults: d.getUint16(18, true), state: d.getUint8(20), reason: d.getUint8(21) } });
          this.bytes.splice(0, 38);
        } catch { this.rejected++; this.bytes.shift(); }
      }
    }
    return out;
  }
}

export function preparePcm(raw: Uint8Array): { bytes: Uint8Array; samples: number; removedDc: number } {
  if (!raw.length || raw.length % 2) throw new Error("RAW PCM 必须非空且字节长度为偶数");
  if (raw.length > 8000 * 2 * 300) throw new Error("音频最长 5 分钟");
  if (new TextDecoder().decode(raw.slice(0, 4)) === "RIFF") throw new Error("请先将 WAV 转成无头的 8 kHz 单声道 s16le RAW PCM");
  const d = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), count = raw.length / 2;
  let sum = 0, peak = 0;
  for (let i = 0; i < count; i++) sum += d.getInt16(i * 2, true);
  const mean = sum / count;
  // DC blocker (~6.4 Hz): a global mean alone turns digital silence into a
  // nonzero constant. Decay it to zero before the firmware's 100 ms guard.
  const filtered = new Float32Array(count);let previous=0,output=0;
  for (let i = 0; i < count; i++) {
    const input=d.getInt16(i*2,true)-mean;
    output=input-previous+.995*output;previous=input;filtered[i]=output;
    peak=Math.max(peak,Math.abs(output));
  }
  const scale = peak > 32767 ? 32767 / peak : 1;
  const bytes = new Uint8Array(raw.length), target = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) target.setInt16(i * 2, Math.round(filtered[i]! * scale), true);
  return { bytes, samples: count, removedDc: mean };
}
export function audioTestTone(): Uint8Array {
  const bytes = new Uint8Array(16000), d = new DataView(bytes.buffer);
  for (let i = 0; i < 8000; i++) d.setInt16(i * 2, Math.round(16000 * Math.sin(2 * Math.PI * 300 * i / 8000)), true);
  return bytes;
}

type Io = { write(bytes: Uint8Array): Promise<void>; cancel(): void; connected(): boolean; now(): number; sleep(ms: number): Promise<void>; changed(status: AudioStatus | null): void };
export class AudioSession {
  readonly parser = new AudioStatusParser();
  status: AudioStatus | null = null;
  sid = 0;
  binary = false;
  cancelled = false;
  retries = 0;
  private configuredCapacity = 2048;
  private configuredWindow = 6;
  get capacity(): number { return this.configuredCapacity; }
  get window(): number { return this.configuredWindow; }
  get lowTx(): boolean { return this.configuredWindow === 12; }
  private opening = "";
  private openingError = "";
  private lastStatus = 0;
  private lastSendAt = 0;
  private closed = false;
  private exitTask: Promise<boolean> | null = null;
  constructor(private io: Io) {}
  receive(chunk: Uint8Array): void {
    let offset = 0;
    if (!this.sid && this.binary) {
      for (; offset < chunk.length; offset++) {
        const byte = chunk[offset]!;
        if (byte === 10) {
          const line = this.opening.trim(); this.opening = "";
          if (line.startsWith("@ERR AUDIO ")) { this.openingError = line; this.binary = false; break; }
          const match = /^@OK AUDIO OPEN v=1 sid=(\d+) rate=8000 bits=16 cap=(\d+) guard=128 prefill=800 window=(\d+)$/.exec(line);
          if (match) {
            const sid = Number(match[1]), capacity = Number(match[2]), window = Number(match[3]);
            if (sid > 0 && sid <= 65535 && (capacity === 2048 && window === 6 || capacity === 4096 && window === 12)) {
              this.configuredCapacity = capacity; this.configuredWindow = window;
              this.sid = sid; this.lastStatus = this.io.now(); offset++; break;
            }
            this.openingError = "音频 OPEN 容量或窗口不支持"; break;
          }
        } else if (byte !== 13) {
          this.opening += String.fromCharCode(byte);
          if (this.opening.length > 191) this.opening = "";
        }
      }
    }
    if (!this.sid) return;
    for (const frame of this.parser.push(chunk.subarray(offset))) {
      if (frame.sid !== this.sid) continue;
      const s = frame.status;
      // Never regress progress/credit after an old cumulative ACK.
      if (this.status && (s.ack < this.status.ack || s.ack === this.status.ack && s.played < this.status.played)) continue;
      this.lastStatus = this.io.now(); this.status = s;
      this.io.changed(s);
    }
  }
  private async send(type: number, seq = 0, payload: Uint8Array = new Uint8Array()): Promise<void> {
    await this.io.write(encodeAudioFrame({ type, sid: this.sid, seq, payload }));
    this.lastSendAt = this.io.now();
  }
  async open(axis: "Q" | "D", amplitude: number): Promise<void> {
    const max = AUDIO_MAX_AMPLITUDE_MA[axis];
    if (!Number.isInteger(amplitude) || amplitude < 1 || amplitude > max) throw new Error(`${axis} 轴幅度须为 1–${max} mA 的整数`);
    if (this.cancelled) throw new Error("操作已取消");
    this.binary = true;
    await this.io.write(new TextEncoder().encode(`AUDIO OPEN ${axis} ${amplitude}\n`));
    this.lastSendAt = this.io.now();
    const deadline = this.io.now() + 1000;
    while (!this.sid && !this.openingError && !this.cancelled && this.io.connected() && this.io.now() < deadline) await this.io.sleep(5);
    if (!this.sid || this.cancelled) throw new Error(this.openingError || "音频 OPEN 未确认或已取消");
  }
  async play(pcm: Uint8Array): Promise<void> {
    const total = Math.ceil(pcm.length / 320), samples = pcm.length / 2;
    let sent = 0, ack = 0, grant = 0, endAt = -Infinity, progressAt = this.io.now(), retryAt = -Infinity, retryAck = -1;
    const retryMs = this.lowTx ? 250 : 100, statusTimeoutMs = this.lowTx ? 500 : 300;
    const pending = new Map<number, number>();
    while (!this.cancelled && this.io.connected()) {
      const now = this.io.now(), s = this.status;
      if (now - this.lastStatus >= statusTimeoutMs) throw new Error("STATUS 超时，已中止播放");
      if (s) {
        if (s.faults || s.state === 5 || s.state === 6 || s.state === 7 || s.underruns) throw new Error(`设备已停止：${audioReason(s)} · 故障 0x${s.faults.toString(16)} · 欠载 ${s.underruns}`);
        if (s.ack > sent || s.played > samples || s.buffer > this.capacity || s.grant < s.ack || s.grant - s.ack > Math.floor((this.capacity - 128) / 160)) throw new Error("STATUS 进度无效");
        if (s.ack > ack) { ack = s.ack; progressAt = now; }
        grant = Math.max(grant, s.grant);
        for (const seq of pending.keys()) if (seq < ack) pending.delete(seq);
        if (s.state === 4) { if (s.played !== samples || ack !== total) throw new Error("播放未完整结束"); return; }
        const errorRetry = [1, 2, 3].includes(s.reason) && retryAck !== ack;
        if (pending.size && (errorRetry || now - progressAt >= retryMs) && now - retryAt >= retryMs) {
          for (const [seq, tries] of pending) {
            if (this.cancelled) break;
            if (tries >= 5) throw new Error("重传次数过多");
            if (seq < ack + this.window && seq < grant) { await this.send(AudioType.DATA, seq, pcm.subarray(seq * 320, Math.min(pcm.length, (seq + 1) * 320))); pending.set(seq, tries + 1); this.retries++; }
          }
          retryAt = progressAt = now; retryAck = ack;
        }
      }
      while (!this.cancelled && sent < total && sent < grant && sent < ack + this.window) {
        await this.send(AudioType.DATA, sent, pcm.subarray(sent * 320, Math.min(pcm.length, (sent + 1) * 320)));
        pending.set(sent, 0); sent++;
      }
      if (this.io.now() - this.lastSendAt >= 100 && !this.cancelled) await this.send(AudioType.PING);
      if (!this.cancelled && ack === total && now - endAt >= 100 && s?.state !== 3) { await this.send(AudioType.END, ack); endAt = now; }
      this.io.changed(this.status);
      await this.io.sleep(5);
    }
    throw new Error(this.cancelled ? "播放已取消" : "串口已断开");
  }
  async pause(): Promise<void> { if (this.sid && !this.cancelled) await this.send(AudioType.PAUSE); }
  async resume(): Promise<void> { if (this.sid && !this.cancelled) await this.send(AudioType.RESUME); }
  cancel(): void { this.cancelled = true; this.io.cancel(); }
  exit(): Promise<boolean> {
    if (this.exitTask) return this.exitTask;
    this.cancel();
    this.exitTask = (async () => {
      if (this.closed || !this.binary) return true;
      if (!this.sid || !this.io.connected()) return false;
      try {
        await this.send(AudioType.ABORT); await this.send(AudioType.EXIT);
        const deadline = this.io.now() + 900; let retry = this.io.now() + 200;
        while (this.io.connected() && this.io.now() < deadline) {
          if (this.status?.state === 7) { this.binary = false; this.closed = true; return true; }
          if (this.io.now() >= retry) { await this.send(AudioType.EXIT); retry += 200; }
          await this.io.sleep(5);
        }
      } catch { /* closed link; caller reconnects after watchdog quiet time */ }
      return false;
    })();
    return this.exitTask;
  }
}
