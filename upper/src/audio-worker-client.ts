import type { AudioIo, AudioPlayer, AudioStatus } from "./audio";

export type WorkerAudioState = { status: AudioStatus | null; sid: number; binary: boolean; retries: number; rejected: number; capacity: number; window: number };
export class WorkerAudioPlayer implements AudioPlayer {
  status: AudioStatus | null = null;
  sid = 0; binary = false; retries = 0;
  parser = { rejected: 0 };
  capacity = 2048; window = 6;
  get lowTx(): boolean { return this.window === 12; }
  constructor(private call: (method: string, args?: unknown) => Promise<unknown>, private io: AudioIo) {}
  update(s: WorkerAudioState): void {
    Object.assign(this, { status: s.status, sid: s.sid, binary: s.binary, retries: s.retries, capacity: s.capacity, window: s.window });
    this.parser.rejected = s.rejected; this.io.changed(this.status);
  }
  receive(): void { /* the worker reads the UART directly */ }
  async open(axis: "Q" | "D", amplitude: number): Promise<void> { this.binary = true; await this.call("audioOpen", { axis, amplitude }); }
  async play(pcm: Uint8Array): Promise<void> { await this.call("audioPlay", pcm); }
  async pause(): Promise<void> { await this.call("audioPause"); }
  async resume(): Promise<void> { await this.call("audioResume"); }
  cancel(): void { void this.call("audioCancel").catch(() => {}); }
  async exit(): Promise<boolean> { const exited = await this.call("audioExit") === true; if (exited) this.binary = false; return exited; }
}
