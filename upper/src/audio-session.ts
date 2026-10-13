import { AUDIO_REASON, AUDIO_STATE, AUDIO_TYPE, AudioFrameDecoder, packAudioFrame, parseAudioStatus, type AudioStatus } from "./audio-protocol.ts";
import { AudioWindow } from "./audio-window.ts";
import type { AudioInput } from "./audio-file.ts";
import type { SerialLink } from "./serial.ts";

export type AudioPhase = "DISCONNECTED" | "ASCII_READY" | "OPENING" | "BUFFERING" | "PLAYING" | "PAUSED" | "DRAINING" | "FINISHED" | "HALTED" | "FAULT" | "CLOSING";
export type AudioSnapshot = {
  phase: AudioPhase; sid: number; sentFrames: number; totalFrames: number;
  ackNextSeq: number; playedSamples: number; bufferSamples: number;
  underruns: number; faults: number; retransmissions: number;
  crcErrors: number; lastReason: number; error: string;
};
type AsciiWait = { cmd: string; resolve: (line: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type BinaryWait = { accept: (status: AudioStatus) => boolean; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class AudioSession {
  phase: AudioPhase = "ASCII_READY";
  private readonly decoder = new AudioFrameDecoder();
  private readonly window: AudioWindow;
  private sid = 0;
  private binary = false;
  private openCommandSent = false;
  private ascii = "";
  private asciiWait: AsciiWait | null = null;
  private statusWait: BinaryWait | null = null;
  private status: AudioStatus | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStatusAt = 0;
  private lastPingAt = 0;
  private writerBusy = false;
  private pauseRequested = false;
  private endSent = false;
  private ending = false;
  private released = false;
  private stopping: Promise<boolean> | null = null;
  private error = "";

  constructor(
    private readonly serial: Pick<SerialLink, "connected" | "writeBytes" | "writeText" | "abortAudio">,
    readonly file: AudioInput,
    private readonly restoreTelem: number,
    private readonly onUpdate: (s: AudioSnapshot) => void,
    private readonly onRelease: (safe: boolean) => void,
  ) {
    this.window = new AudioWindow(file.frames);
    this.update();
  }

  get active(): boolean { return !this.released; }
  get inBinaryMode(): boolean { return this.binary || this.openCommandSent; }

  snapshot(): AudioSnapshot {
    return {
      phase: this.phase, sid: this.sid, sentFrames: this.window.sentFrames,
      totalFrames: this.window.totalFrames, ackNextSeq: this.window.ackNextSeq,
      playedSamples: this.status?.playedSamples ?? 0,
      bufferSamples: this.status?.bufferSamples ?? 0,
      underruns: this.status?.underrunCount ?? 0, faults: this.status?.faultFlags ?? 0,
      retransmissions: this.window.retransmissions,
      crcErrors: this.decoder.crcErrors, lastReason: this.status?.reasonCode ?? 0, error: this.error,
    };
  }
  private update(): void { this.onUpdate(this.snapshot()); }

  /** Exclusive demux. A single chunk may contain the final ASCII OPEN line followed by STATUS. */
  onData(chunk: Uint8Array): void {
    if (this.released) return;
    let i = 0;
    while (i < chunk.length) {
      if (this.binary) {
        const frames = this.decoder.push(chunk.subarray(i));
        for (const frame of frames) {
          if (frame.type !== AUDIO_TYPE.STATUS || frame.sid !== this.sid) continue;
          try { this.receiveStatus(parseAudioStatus(frame, this.sid)); }
          catch (e) { this.fault("STATUS 非法：" + String(e)); }
        }
        return;
      }
      const b = chunk[i++]!;
      if (b === 10) {
        const line = this.ascii.trim();
        this.ascii = "";
        if (line) this.receiveAscii(line);
      } else if (b >= 32 && b <= 126) {
        this.ascii += String.fromCharCode(b);
        if (this.ascii.length > 512) this.ascii = "";
      } else if (b === 13) {
        // CRLF
      } else if (this.ascii.length && b !== 0) {
        this.ascii = "";
      }
    }
  }

  private receiveAscii(line: string): void {
    const wait = this.asciiWait;
    if (!wait) return;
    if (line.startsWith("@ERR ")) {
      clearTimeout(wait.timer); this.asciiWait = null;
      // OPEN ERR leaves the MCU in ASCII; a missing OPEN response is ambiguous.
      if (wait.cmd === "AUDIO OPEN") this.openCommandSent = false;
      wait.reject(new Error(line)); return;
    }
    if (!line.startsWith("@OK " + wait.cmd) ||
        (line.length > 4 + wait.cmd.length && line[4 + wait.cmd.length] !== " ")) return;
    if (wait.cmd === "AUDIO OPEN") {
      const match = /^@OK AUDIO OPEN v=1 sid=(\d+) rate=8000 bits=16 cap=2048 guard=128 prefill=800 window=6$/.exec(line);
      const sid = match ? Number(match[1]) : 0;
      if (!Number.isInteger(sid) || sid < 1 || sid > 65535) {
        clearTimeout(wait.timer); this.asciiWait = null;
        wait.reject(new Error("AUDIO OPEN 应答不符合冻结协议（串口模式未知）")); return;
      }
      this.sid = sid;
      this.binary = true; this.openCommandSent = false;
      this.lastStatusAt = performance.now();
    }
    clearTimeout(wait.timer); this.asciiWait = null; wait.resolve(line);
  }

  private async asciiCommand(command: string, timeout = 800): Promise<string> {
    if (this.asciiWait || !this.serial.connected || this.binary) throw new Error("ASCII 链路被占用或尚未退出 AUDIO");
    const cmd = command.split(" ").slice(0, command.startsWith("AUDIO OPEN") ? 2 : 1).join(" ");
    let waiter: AsciiWait | null = null;
    const promise = new Promise<string>((resolve, reject) => {
      waiter = { cmd, resolve, reject, timer: setTimeout(() => {
        if (this.asciiWait === waiter) this.asciiWait = null;
        reject(new Error(cmd + " 未收到 @OK（超时）"));
      }, timeout) };
      this.asciiWait = waiter;
    });
    if (cmd === "AUDIO OPEN") this.openCommandSent = true;
    try { await this.serial.writeText(command + "\n"); }
    catch (e) {
      if (waiter) clearTimeout(waiter.timer);
      this.asciiWait = null;
      // OPEN write may have partially succeeded; treat mode as unknown.
      void promise.catch(() => {});
      throw e;
    }
    return promise;
  }

  /** Caller has already disabled all other control writers and verified INFO. */
  async start(axis: "Q" | "D", ampMa: number): Promise<void> {
    if (!Number.isInteger(ampMa) || ampMa < 1 || ampMa > 200) throw new Error("幅值必须为 1..200 mA 整数");
    try {
      this.phase = "OPENING"; this.update();
      for (const cmd of ["STOP", "AE 0", "TELEM 0", "RUN", "IQ 0"])
        await this.asciiCommand(cmd);
      await this.asciiCommand(`AUDIO OPEN ${axis} ${ampMa}`, 1200);
      this.phase = "BUFFERING"; this.update();
      this.timer = setInterval(() => { void this.tick(); }, 10);
      await this.sendBinary(AUDIO_TYPE.PING);
    } catch (e) {
      this.error = String(e instanceof Error ? e.message : e);
      await this.stop("打开音频失败：" + this.error);
      throw new Error(this.error);
    }
  }

  private receiveStatus(next: AudioStatus): void {
    if (next.playedSamples > this.file.samples ||
        next.bufferSamples > 2048 || next.ackNextSeq > this.window.totalFrames ||
        (this.status && (next.playedSamples < this.status.playedSamples ||
          next.underrunCount < this.status.underrunCount))) {
      this.fault("MCU STATUS 计数异常"); return;
    }
    this.lastStatusAt = performance.now();
    this.status = next;
    if (next.stateCode === AUDIO_STATE.EXITED) {
      this.binary = false;
      this.phase = "CLOSING";
      this.resolveWait(next); this.update();
      return;
    }
    if (!this.stopping && next.stateCode === AUDIO_STATE.HALTED || !this.stopping && next.stateCode === AUDIO_STATE.FAULT) {
      this.phase = next.stateCode === AUDIO_STATE.FAULT ? "FAULT" : "HALTED";
      this.fault("MCU 已停机，原因码 " + next.reasonCode + "；请核对硬件急停");
      return;
    }
    if (next.faultFlags !== 0 || next.reasonCode === AUDIO_REASON.SAFETY_FAULT ||
        next.reasonCode === AUDIO_REASON.MODE_CHANGED ||
        next.reasonCode === AUDIO_REASON.PROTOCOL_ERROR ||
        next.reasonCode === AUDIO_REASON.TIMEOUT) {
      this.fault("MCU 安全故障或协议错误，reason=" + next.reasonCode);
      return;
    }
    if (!this.stopping) {
      try {
        this.window.status(next.ackNextSeq, next.grantSeqExclusive);
        if (next.reasonCode === AUDIO_REASON.CRC_ERROR ||
            next.reasonCode === AUDIO_REASON.SEQ_GAP ||
            next.reasonCode === AUDIO_REASON.BUFFER_FULL) this.window.nack();
      } catch (e) { this.fault("AUDIO ACK/credit 非法：" + String(e)); return; }
      const phases: AudioPhase[] = ["BUFFERING", "PLAYING", "PAUSED", "DRAINING", "FINISHED", "HALTED", "FAULT", "CLOSING"];
      this.phase = phases[next.stateCode]!;
      if (next.stateCode === AUDIO_STATE.FINISHED && this.endSent && !this.ending) {
        this.ending = true;
        void this.finish();
      }
    }
    this.resolveWait(next);
    this.update();
  }

  private resolveWait(status: AudioStatus): void {
    const wait = this.statusWait;
    if (!wait || !wait.accept(status)) return;
    this.statusWait = null; clearTimeout(wait.timer); wait.resolve();
  }
  private awaitStatus(accept: (status: AudioStatus) => boolean, timeout: number): Promise<void> {
    if (this.statusWait) throw new Error("已有未完成的 STATUS 等待");
    return new Promise((resolve, reject) => {
      const wait: BinaryWait = {
        accept, resolve, reject, timer: setTimeout(() => {
          if (this.statusWait === wait) this.statusWait = null;
          reject(new Error("等待 AUDIO STATUS 超时"));
        }, timeout),
      };
      this.statusWait = wait;
    });
  }

  private async sendBinary(type: number, seq = 0, payload: Uint8Array = new Uint8Array()): Promise<void> {
    if (!this.binary || !this.sid || !this.serial.connected) throw new Error("AUDIO 二进制链路不可用");
    await this.serial.writeBytes(packAudioFrame(type, this.sid, seq, payload));
  }

  private async tick(): Promise<void> {
    if (this.released || this.stopping || this.phase === "CLOSING") return;
    const now = performance.now();
    if (!this.binary) return;
    if (now - this.lastStatusAt > 300) { this.fault("300ms 未收到 AUDIO STATUS，停机状态未知"); return; }
    if (this.writerBusy) return;
    // PING every 100ms even while PAUSED, under credit backpressure, or while draining.
    if (now - this.lastPingAt >= 100) {
      this.lastPingAt = now;
      this.writerBusy = true;
      try { await this.sendBinary(AUDIO_TYPE.PING); }
      catch (e) { this.fault("PING 发送失败：" + String(e)); }
      finally { this.writerBusy = false; }
      return;
    }
    if (this.pauseRequested || this.phase === "PAUSED" || this.phase === "DRAINING" || this.phase === "FINISHED") return;
    if (this.window.completed && !this.endSent) {
      this.endSent = true; this.writerBusy = true;
      try { await this.sendBinary(AUDIO_TYPE.END, this.window.totalFrames); }
      catch (e) { this.fault("END 发送失败：" + String(e)); }
      finally { this.writerBusy = false; }
      return;
    }
    let frame;
    try { frame = this.window.next(now); }
    catch (e) { this.fault(String(e)); return; }
    if (!frame) return;
    this.writerBusy = true;
    try { await this.sendBinary(AUDIO_TYPE.DATA, frame.seq, frame.samples); }
    catch (e) { this.fault("DATA 发送失败：" + String(e)); }
    finally { this.writerBusy = false; this.update(); }
  }

  async pause(): Promise<void> {
    if (this.stopping || !["BUFFERING", "PLAYING", "DRAINING"].includes(this.phase)) return;
    this.pauseRequested = true;
    const wait = this.awaitStatus(s => s.stateCode === AUDIO_STATE.PAUSED, 800);
    try { await this.sendBinary(AUDIO_TYPE.PAUSE); await wait; }
    catch (e) { void wait.catch(() => {}); this.fault("PAUSE 未确认：" + String(e)); }
  }
  async resume(): Promise<void> {
    if (this.stopping || this.phase !== "PAUSED") return;
    const wait = this.awaitStatus(s => s.stateCode === AUDIO_STATE.PLAYING ||
      s.stateCode === AUDIO_STATE.BUFFERING || s.stateCode === AUDIO_STATE.DRAINING, 800);
    try { await this.sendBinary(AUDIO_TYPE.RESUME); await wait; this.pauseRequested = false; }
    catch (e) { void wait.catch(() => {}); this.fault("RESUME 未确认：" + String(e)); }
  }

  private fault(reason: string): void {
    if (this.stopping || this.released) return;
    this.error = reason; this.phase = "FAULT"; this.update();
    void this.stop(reason);
  }

  private async finish(): Promise<void> {
    await this.stop("已播放完成", false);
  }

  /** ABORT is higher priority than queued DATA; never send ASCII until EXITED. */
  stop(reason: string, abort = true): Promise<boolean> {
    if (this.stopping) return this.stopping;
    this.window.halt();
    this.pauseRequested = true;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.phase = "CLOSING"; this.update();
    this.stopping = this.shutdown(reason, abort);
    return this.stopping;
  }

  private async shutdown(reason: string, abort: boolean): Promise<boolean> {
    let safe = false;
    try {
      if (!this.serial.connected) throw new Error("串口已经断开");
      if (this.binary) {
        if (abort) {
          await this.serial.abortAudio(packAudioFrame(AUDIO_TYPE.ABORT, this.sid, 0));
          // The MCU disables on ABORT even if its acknowledgement is lost; EXIT is the recovery path.
        }
        const wait = this.awaitStatus(s => s.stateCode === AUDIO_STATE.EXITED, 650);
        try { await this.sendBinary(AUDIO_TYPE.EXIT); await wait; }
        catch (e) { void wait.catch(() => {}); throw e; }
      } else if (this.openCommandSent) {
        throw new Error("OPEN 已发出但串口模式未知，禁止发送裸 ASCII STOP");
      }
      // receiveStatus(EXITED) switched the demux to ASCII.
      await this.asciiCommand("STOP");
      await this.asciiCommand("AE 0");
      await this.asciiCommand("TELEM " + (this.restoreTelem === 1 ? 1 : 0));
      safe = true;
      this.phase = abort ? "HALTED" : "FINISHED";
    } catch (e) {
      this.error = reason + "；退出/停机未确认：" + String(e instanceof Error ? e.message : e)
        + "。请使用硬件急停，勿假定已经停机";
      this.phase = "FAULT";
    } finally {
      if (this.asciiWait) { clearTimeout(this.asciiWait.timer); this.asciiWait.reject(new Error("会话关闭")); this.asciiWait = null; }
      if (this.statusWait) { clearTimeout(this.statusWait.timer); this.statusWait.reject(new Error("会话关闭")); this.statusWait = null; }
      this.released = true; this.update(); this.onRelease(safe);
    }
    return safe;
  }

  disconnected(reason: string): void {
    if (this.released) return;
    this.error = "串口断开：" + reason + "；停机状态未知，请使用硬件急停";
    this.phase = "FAULT"; this.window.halt();
    if (this.timer) clearInterval(this.timer);
    if (this.asciiWait) { clearTimeout(this.asciiWait.timer); this.asciiWait.reject(new Error(reason)); this.asciiWait = null; }
    if (this.statusWait) { clearTimeout(this.statusWait.timer); this.statusWait.reject(new Error(reason)); this.statusWait = null; }
    this.released = true; this.update(); this.onRelease(false);
  }
}
