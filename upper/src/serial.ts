/** Web Serial wrapper for the DR4310 USART1 (JustFloat + optional @reply lines out, ASCII commands in). */
export class SerialLink {
  port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private running = false;
  private generation = 0;
  private writes = 0;
  private readDone: Promise<void> = Promise.resolve();
  private enc = new TextEncoder();
  baudRate = 0;
  onData: ((chunk: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;

  get connected(): boolean { return !!this.port && this.running; }

  async open(baud: number): Promise<void> {
    if (!("serial" in navigator)) throw new Error("当前浏览器不支持 Web Serial（需 Chrome/Edge + HTTPS）");
    const port = await navigator.serial.requestPort();
    await this.openPort(port, baud);
  }

  /** Open an already-granted port (auto-reconnect via navigator.serial.getPorts()). */
  async openPort(port: SerialPort, baud: number): Promise<void> {
    await port.open({ baudRate: baud, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none", bufferSize: 65536 });
    this.port = port;
    this.baudRate = baud;
    this.running = true;
    const generation = ++this.generation;
    this.readDone = this.readLoop(port, generation);
  }

  private async readLoop(port: SerialPort, generation: number): Promise<void> {
    let reason = "数据流已关闭";
    try {
      while (this.running && generation === this.generation && port.readable) {
        const reader = port.readable.getReader();
        this.reader = reader;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done || generation !== this.generation || !this.running) return;
            if (value && value.length) this.onData?.(value);
          }
        } catch (e) {
          reason = e instanceof Error ? e.message : String(e);
          return;
        } finally {
          reader.releaseLock();
          if (this.reader === reader) this.reader = null;
        }
      }
    } finally {
      if (generation === this.generation && this.running) {
        this.running = false;
        this.cancelPending();
        this.onClose?.(reason);
      }
    }
  }

  private writeChain: Promise<void> = Promise.resolve();

  cancelPending(): void { this.writes++; }

  /** Writes are serialized: concurrent callers would otherwise fight over the writer lock. */
  writeText(s: string): Promise<void> {
    return this.writeBytes(this.enc.encode(s));
  }

  writeBytes(bytes: Uint8Array): Promise<void> {
    const data = new Uint8Array(bytes);
    const port = this.port, writes = this.writes, generation = this.generation;
    const run = async () => {
      if (writes !== this.writes || generation !== this.generation) throw new Error("发送已取消");
      if (!port?.writable || !this.connected) throw new Error("串口未打开");
      const w = port.writable.getWriter();
      try { await w.write(data); } finally { w.releaseLock(); }
    };
    const p = this.writeChain.then(run, run);
    this.writeChain = p.catch(() => undefined);
    return p;
  }

  async close(): Promise<void> {
    const port = this.port;
    this.running = false;
    this.generation++;
    this.cancelPending();
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    // never let a stuck read/write (unplugged adapter) block close forever
    const settle = (pr: Promise<unknown>) => Promise.race([pr.catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
    await settle(this.readDone);
    await settle(this.writeChain);
    try { await port?.close(); } catch { /* ignore */ }
    if (this.port === port) this.port = null;
  }
}
