import { SerialPortTransport } from "./serial-port";
import { AudioSession, type AudioIo, type AudioPlayer } from "./audio";
import { WorkerAudioPlayer, type WorkerAudioState } from "./audio-worker-client";

/** Native Web Serial lives in a dedicated worker; test adapters retain the direct transport. */
export class SerialLink extends SerialPortTransport {
  private worker: Worker | null = null;
  private workerConnected = false;
  private nextId = 0;
  private requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | null }>();
  private player: WorkerAudioPlayer | null = null;
  private closing: Promise<void> | null = null;
  get connected(): boolean { return this.worker ? this.workerConnected : super.connected; }
  get backgroundAudio(): boolean { return !!this.worker && this.workerConnected; }
  audioSession(io: AudioIo): AudioPlayer {
    if (!this.worker) return new AudioSession(io);
    this.player = new WorkerAudioPlayer((method, args) => this.call(method, args), io);
    return this.player;
  }
  private call(method: string, args?: unknown): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("串口工作线程已关闭"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = method === "audioPlay" ? null : setTimeout(() => { this.requests.delete(id); reject(new Error("串口工作线程应答超时")); }, 5000);
      this.requests.set(id, { resolve, reject, timer }); worker.postMessage({ id, method, args });
    });
  }
  async openPort(port: SerialPort, baud: number): Promise<void> {
    if (this.closing) await this.closing;
    if (this.connected) throw new Error("串口已经连接");
    if (Object.prototype.toString.call(port) !== "[object SerialPort]" || typeof Worker === "undefined") { await super.openPort(port, baud); return; }
    const selected = port.getInfo();
    const worker = new Worker(new URL("./serial-worker.js", document.baseURI));
    this.worker = worker; this.port = port; this.baudRate = baud;
    worker.onmessage = ({ data }: MessageEvent) => {
      if (worker !== this.worker) return;
      if (data.event === "data") this.onData?.(new Uint8Array(data.bytes));
      else if (data.event === "audio") this.player?.update(data.state as WorkerAudioState);
      else if (data.event === "closed") { this.workerConnected = false; this.onClose?.(data.reason); }
      else {
        const request = this.requests.get(data.id); if (!request) return;
        this.requests.delete(data.id); if (request.timer) clearTimeout(request.timer);
        if (data.error) request.reject(new Error(data.error)); else request.resolve(data.value);
      }
    };
    worker.onerror = () => { this.workerConnected = false; this.onClose?.("串口工作线程异常，音频看门狗将停止电机"); void this.close(); };
    try { await this.call("open", { selected, baud }); this.workerConnected = true; }
    catch (e) { await this.close(); throw e; }
  }
  writeBytes(bytes: Uint8Array): Promise<void> { return this.worker ? this.call("write", bytes).then(() => {}) : super.writeBytes(bytes); }
  cancelPending(): void { if (this.worker) void this.call("cancel").catch(() => {}); else super.cancelPending(); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeWorker().finally(() => { this.closing = null; });
    return this.closing;
  }
  private async closeWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) { await super.close(); return; }
    try { await this.call("close"); } catch { /* firmware watchdog handles a lost worker */ }
    this.workerConnected = false; worker.terminate(); this.worker = null; this.player = null; this.port = null;
    for (const request of this.requests.values()) { if (request.timer) clearTimeout(request.timer); request.reject(new Error("串口已关闭")); }
    this.requests.clear();
  }
}
