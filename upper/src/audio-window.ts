/** Pure ACK/grant sliding-window core, independent of timers, serial writer and MCU state codes. */
export type AudioDispatch = { seq: number; retry: boolean; samples: Uint8Array };
type Pending = { lastAt: number; attempts: number };

export class AudioWindow {
  readonly frames: readonly Uint8Array[];
  private ack = 0;
  private nextSeq = 0;
  private grant = 0;
  private pending = new Map<number, Pending>();
  retransmissions = 0;
  private stopped = false;
  private retryRequested = false;

  constructor(frames: readonly Uint8Array[], private readonly maxWindow = 6) {
    if (!frames.length || maxWindow < 1 || maxWindow > 6) throw new Error("无效的 AUDIO 窗口");
    for (let i = 0; i < frames.length; i++) {
      if (!frames[i]!.length || (frames[i]!.length & 1) ||
          frames[i]!.length > 320 || (i !== frames.length - 1 && frames[i]!.length !== 320))
        throw new Error("仅最后一帧可以少于 160 samples");
    }
    this.frames = frames;
  }

  get ackNextSeq(): number { return this.ack; }
  get sentFrames(): number { return this.nextSeq; }
  get totalFrames(): number { return this.frames.length; }
  get completed(): boolean { return this.ack === this.frames.length; }
  get inFlight(): number { return this.pending.size; }
  halt(): void { this.stopped = true; this.pending.clear(); }

  /** Returns false for duplicate/old STATUS; rejects ACK that was never written. */
  status(ackNextSeq: number, grantSeqExclusive: number): boolean {
    if (!Number.isSafeInteger(ackNextSeq) || !Number.isSafeInteger(grantSeqExclusive) ||
        ackNextSeq < 0 || grantSeqExclusive < 0 || ackNextSeq > this.nextSeq ||
        grantSeqExclusive < ackNextSeq)
      throw new Error("MCU AUDIO ACK/grant 非法");
    if (ackNextSeq < this.ack) return false;
    this.grant = Math.max(this.grant, grantSeqExclusive);
    if (ackNextSeq === this.ack) return false;
    for (let n = this.ack; n < ackNextSeq; n++) this.pending.delete(n);
    this.ack = ackNextSeq;
    this.retryRequested = false;
    return true;
  }

  /** A recoverable MCU NACK schedules an immediate retransmit of the earliest unacknowledged DATA. */
  nack(): void { if (this.pending.size) this.retryRequested = true; }

  /** Reserve exactly one DATA frame. Writer should call failed() if transmission rejects. */
  next(now: number): AudioDispatch | null {
    if (this.stopped) return null;
    for (const [seq, p] of this.pending) {
      if (now - p.lastAt >= 100 || this.retryRequested && seq === this.ack) {
        this.retryRequested = false;
        if (p.attempts >= 6) throw new Error("AUDIO DATA 超过 5 次重传");
        p.lastAt = now; p.attempts++; this.retransmissions++;
        return { seq, retry: true, samples: this.frames[seq]! };
      }
    }
    if (this.nextSeq >= this.frames.length ||
        this.nextSeq >= this.grant ||
        this.nextSeq >= this.ack + this.maxWindow ||
        this.pending.size >= this.maxWindow) return null;
    const seq = this.nextSeq++;
    this.pending.set(seq, { lastAt: now, attempts: 1 });
    return { seq, retry: false, samples: this.frames[seq]! };
  }

  failed(seq: number): void {
    this.halt();
    throw new Error("AUDIO 串口发送失败，序号 " + seq + "；不能安全继续流");
  }
}
