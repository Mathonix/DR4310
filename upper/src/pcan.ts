/**
 * PEAK-System PCAN-USB (classic) proprietary USB protocol
 * Ported from Linux drivers/net/can/usb/peak_usb/pcan_usb.c
 *
 * Classic PCAN-USB (PID 0x000C) only. FD / Pro variants use different
 * framing — filter them in UI but do not claim full support yet.
 */

export const PCAN_USB_VENDOR_ID = 0x0c72;

/** Classic PCAN-USB — primary target */
export const PCAN_USB_PRODUCT_ID = 0x000c;
/** Listed in kernel peak_usb_table; protocol differs — not fully supported */
export const PCAN_USBPRO_PRODUCT_ID = 0x000d;
export const PCAN_USBPROFD_PRODUCT_ID = 0x0011;
export const PCAN_USBFD_PRODUCT_ID = 0x0012;
export const PCAN_USBCHIP_PRODUCT_ID = 0x0013;
export const PCAN_USBX6_PRODUCT_ID = 0x0014;

export const CLASSIC_PIDS = [PCAN_USB_PRODUCT_ID] as const;
export const KNOWN_PIDS = [
  PCAN_USB_PRODUCT_ID,
  PCAN_USBPRO_PRODUCT_ID,
  PCAN_USBPROFD_PRODUCT_ID,
  PCAN_USBFD_PRODUCT_ID,
  PCAN_USBCHIP_PRODUCT_ID,
  PCAN_USBX6_PRODUCT_ID,
] as const;

export const PID_NAMES: Record<number, string> = {
  [PCAN_USB_PRODUCT_ID]: "PCAN-USB",
  [PCAN_USBPRO_PRODUCT_ID]: "PCAN-USB Pro",
  [PCAN_USBPROFD_PRODUCT_ID]: "PCAN-USB Pro FD",
  [PCAN_USBFD_PRODUCT_ID]: "PCAN-USB FD",
  [PCAN_USBCHIP_PRODUCT_ID]: "PCAN-Chip USB",
  [PCAN_USBX6_PRODUCT_ID]: "PCAN-USB X6",
};

/* Endpoints (classic PCAN-USB) */
export const EP_CMDOUT = 1;
export const EP_CMDIN = 0x81;
export const EP_MSGOUT = 2;
export const EP_MSGIN = 0x82;

export const CMD_LEN = 16;
export const CMD_ARGS_LEN = 14;
export const RX_BUFFER_SIZE = 64;
export const TX_BUFFER_SIZE = 64;
export const MSG_HEADER_LEN = 2;
export const MSG_TX_CAN = 2;

export const CMD_BITRATE = 1;
export const CMD_SET_BUS = 3;
export const CMD_DEVID = 4;
export const CMD_SN = 6;
export const CMD_REGISTER = 9;
export const CMD_EXT_VCC = 10;
export const CMD_ERR_FR = 11;
export const CMD_LED = 12;

export const BUS_XCVER = 2;
export const BUS_SILENT_MODE = 3;
export const CMD_GET = 1;
export const CMD_SET = 2;

export const SJA1000_MODE_NORMAL = 0x00;
export const SJA1000_MODE_INIT = 0x01;

export const STATUSLEN_TIMESTAMP = 1 << 7;
export const STATUSLEN_INTERNAL = 1 << 6;
export const STATUSLEN_EXT_ID = 1 << 5;
export const STATUSLEN_RTR = 1 << 4;
export const STATUSLEN_DLC = 0x0f;

export const TX_SRR = 0x01;
export const TX_AT = 0x02;

export const ERROR_TXFULL = 0x01;
export const ERROR_RXQOVR = 0x02;
export const ERROR_BUS_LIGHT = 0x04;
export const ERROR_BUS_HEAVY = 0x08;
export const ERROR_BUS_OFF = 0x10;
export const ERROR_RXQEMPTY = 0x20;
export const ERROR_QOVR = 0x40;
export const ERROR_TXQFULL = 0x80;

export const REC_ERROR = 1;
export const REC_ANALOG = 2;
export const REC_BUSLOAD = 3;
export const REC_TS = 4;
export const REC_BUSEVT = 5;

export const ERR_RXERR = 0x02;
export const ERR_TXERR = 0x04;
export const BERR_MASK = ERR_RXERR | ERR_TXERR;

/** PCAN-USB crystal 16 MHz → CAN clock = 8 MHz */
export const CAN_CLOCK_HZ = 8_000_000;

export type CanFrame = {
  id: number;
  ext: boolean;
  rtr: boolean;
  dlc: number;
  data: Uint8Array;
  ts?: number;
  dir: "rx" | "tx";
  error?: boolean;
  errorFlags?: number;
  busState?: string;
};

export type BusStats = {
  rxerr: number;
  txerr: number;
  busOff: boolean;
  busHeavy: boolean;
  busLight: boolean;
  rxOverflow: boolean;
};

function le16(buf: Uint8Array, off: number): number {
  return buf[off]! | (buf[off + 1]! << 8);
}

function le32(buf: Uint8Array, off: number): number {
  return (
    (buf[off]! |
      (buf[off + 1]! << 8) |
      (buf[off + 2]! << 16) |
      (buf[off + 3]! << 24)) >>>
    0
  );
}

function putLe16(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
}

function putLe32(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
  buf[off + 2] = (v >> 16) & 0xff;
  buf[off + 3] = (v >> 24) & 0xff;
}

/** SJA1000 BTR0/BTR1 for common bitrates @ 8 MHz CAN clock */
export const PRESET_BTR: Record<number, { btr0: number; btr1: number }> = {
  1_000_000: { btr0: 0x00, btr1: 0x14 },
  800_000: { btr0: 0x00, btr1: 0x16 },
  500_000: { btr0: 0x00, btr1: 0x1c },
  250_000: { btr0: 0x01, btr1: 0x1c },
  125_000: { btr0: 0x03, btr1: 0x1c },
  100_000: { btr0: 0x04, btr1: 0x1c },
  50_000: { btr0: 0x09, btr1: 0x1c },
  20_000: { btr0: 0x18, btr1: 0x1c },
  10_000: { btr0: 0x31, btr1: 0x1c },
};

/**
 * Compute SJA1000 BTR0/BTR1 for target bitrate with 8 MHz clock.
 * Prefer sample point ~87.5% (75% at 1 Mbit).
 */
export function computeBtr(bitrate: number): { btr0: number; btr1: number } | null {
  if (PRESET_BTR[bitrate]) return PRESET_BTR[bitrate]!;

  const clock = CAN_CLOCK_HZ;
  let best: { btr0: number; btr1: number; err: number; sp: number } | null = null;

  for (let brp = 1; brp <= 64; brp++) {
    for (let tseg1 = 1; tseg1 <= 16; tseg1++) {
      for (let tseg2 = 1; tseg2 <= 8; tseg2++) {
        const tq = tseg1 + tseg2 + 1; // sync=1
        if (tq < 5) continue;
        const rate = clock / (brp * tq);
        const err = Math.abs(rate - bitrate) / bitrate;
        if (err > 0.005) continue;
        const sp = (1 + tseg1) / tq;
        const sjw = Math.min(4, tseg2);
        const btr0 = ((brp - 1) & 0x3f) | (((sjw - 1) & 0x3) << 6);
        const btr1 = ((tseg1 - 1) & 0xf) | (((tseg2 - 1) & 0x7) << 4);
        const score = err * 1000 + Math.abs(sp - 0.875);
        if (!best || score < best.err * 1000 + Math.abs(best.sp - 0.875)) {
          best = { btr0, btr1, err, sp };
        }
      }
    }
  }
  return best ? { btr0: best.btr0, btr1: best.btr1 } : null;
}

export type FrameHandler = (frame: CanFrame) => void;
export type StatusHandler = (stats: BusStats, message?: string) => void;

export class PcanUsbDevice {
  device: USBDevice;
  private iface = 0;
  private running = false;
  private txSeq = 0;
  private ts16 = 0;
  private prevTs8 = 0;
  private bus: BusStats = {
    rxerr: 0,
    txerr: 0,
    busOff: false,
    busHeavy: false,
    busLight: false,
    rxOverflow: false,
  };
  onFrame: FrameHandler | null = null;
  onStatus: StatusHandler | null = null;
  productId: number;
  /** Queue TX so rapid clicks never overlap transferOut (common WinUSB hang). */
  private txChain: Promise<unknown> = Promise.resolve();
  private txGeneration = 0;
  private cmdChain: Promise<unknown> = Promise.resolve();

  constructor(device: USBDevice) {
    this.device = device;
    this.productId = device.productId;
  }

  private withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    return Promise.race([
      p.finally(() => {
        if (timer) clearTimeout(timer);
      }),
      new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  }

  get isClassic(): boolean {
    return this.productId === PCAN_USB_PRODUCT_ID;
  }

  get productName(): string {
    return PID_NAMES[this.productId] ?? `PEAK 0x${this.productId.toString(16)}`;
  }

  async open(): Promise<void> {
    if (!this.device.opened) {
      await this.device.open();
    }
    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }
    // Prefer interface that has our endpoints
    const cfg = this.device.configuration;
    if (cfg) {
      for (const alt of cfg.interfaces) {
        const eps = alt.alternates[0]?.endpoints ?? [];
        const addrs = new Set(eps.map((e) => e.endpointNumber | (e.direction === "in" ? 0x80 : 0)));
        if (
          addrs.has(EP_CMDOUT) &&
          addrs.has(EP_CMDIN) &&
          addrs.has(EP_MSGOUT) &&
          addrs.has(EP_MSGIN)
        ) {
          this.iface = alt.interfaceNumber;
          break;
        }
      }
    }
    try {
      await this.device.claimInterface(this.iface);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `claimInterface 失败: ${msg}。Windows 上若已安装 PEAK 官方驱动，WebUSB 无法声明接口——请用 Zadig 将该 PCAN 接口切换为 WinUSB，或临时卸载 PEAK 驱动后重试。`
      );
    }
  }

  async close(): Promise<void> {
    this.running = false;
    try {
      if (this.device.opened) {
        try {
          await this.setBus(false);
        } catch {
          /* ignore */
        }
        try {
          await this.device.releaseInterface(this.iface);
        } catch {
          /* ignore */
        }
        await this.device.close();
      }
    } catch {
      /* ignore */
    }
  }

  private async sendCmd(func: number, num: number, args?: Uint8Array | number[]): Promise<void> {
    const run = this.cmdChain.then(async () => {
      const buf = new Uint8Array(CMD_LEN);
      buf[0] = func;
      buf[1] = num;
      if (args) {
        const a = args instanceof Uint8Array ? args : new Uint8Array(args);
        buf.set(a.subarray(0, CMD_ARGS_LEN), 2);
      }
      await this.withTimeout(this.device.transferOut(EP_CMDOUT, buf), 2000, "命令发送");
    });
    this.cmdChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async waitRsp(func: number, num: number): Promise<Uint8Array> {
    await this.sendCmd(func, num);
    const r = await this.device.transferIn(EP_CMDIN, CMD_LEN);
    if (!r.data || r.status !== "ok") {
      throw new Error(`命令响应失败 f=${func} n=${num}`);
    }
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async getSerial(): Promise<number> {
    const rsp = await this.waitRsp(CMD_SN, CMD_GET);
    return le32(rsp, 2);
  }

  async setBittiming(btr0: number, btr1: number): Promise<void> {
    // kernel: args[0]=btr1, args[1]=btr0
    await this.sendCmd(CMD_BITRATE, CMD_SET, [btr1 & 0xff, btr0 & 0xff]);
  }

  async setBitrate(bitrate: number): Promise<{ btr0: number; btr1: number }> {
    const btr = computeBtr(bitrate);
    if (!btr) throw new Error(`无法计算比特率 ${bitrate} 的 BTR（8 MHz 时钟）`);
    await this.setBittiming(btr.btr0, btr.btr1);
    return btr;
  }

  async setBus(on: boolean): Promise<void> {
    await this.sendCmd(CMD_SET_BUS, BUS_XCVER, [on ? 1 : 0]);
    if (!on) {
      await this.sendCmd(CMD_REGISTER, CMD_SET, [0, SJA1000_MODE_INIT]);
    } else {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async setSilent(on: boolean): Promise<void> {
    await this.sendCmd(CMD_SET_BUS, BUS_SILENT_MODE, [on ? 1 : 0]);
  }

  async setErrFrame(mask: number): Promise<void> {
    await this.sendCmd(CMD_ERR_FR, CMD_SET, [mask & 0xff]);
  }

  async setExtVcc(on: boolean): Promise<void> {
    await this.sendCmd(CMD_EXT_VCC, CMD_SET, [on ? 1 : 0]);
  }

  async start(bitrate: number, silent = false): Promise<{ btr0: number; btr1: number }> {
    if (!this.isClassic) {
      throw new Error(
        `当前设备 ${this.productName} (PID 0x${this.productId.toString(16)}) 协议与经典 PCAN-USB 不同，暂不支持。请使用经典 PCAN-USB (0x000C)。`
      );
    }
    const btr = await this.setBitrate(bitrate);
    try {
      await this.setErrFrame(BERR_MASK);
    } catch {
      /* older fw */
    }
    try {
      await this.setSilent(silent);
    } catch {
      /* rev <= 3 */
    }
    try {
      await this.setExtVcc(false);
    } catch {
      /* optional */
    }
    await this.setBus(true);
    this.running = true;
    this.readLoop();
    return btr;
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      await this.setBus(false);
    } catch {
      /* ignore */
    }
  }

  private async readLoop(): Promise<void> {
    while (this.running && this.device.opened) {
      try {
        const r = await this.device.transferIn(EP_MSGIN, RX_BUFFER_SIZE);
        if (!this.running) break;
        if (r.status === "ok" && r.data && r.data.byteLength > MSG_HEADER_LEN) {
          const buf = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
          this.decodeMsg(buf);
        }
      } catch (e) {
        if (!this.running) break;
        const msg = e instanceof Error ? e.message : String(e);
        this.onStatus?.(this.bus, `读取中断: ${msg}`);
        // brief pause then retry
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  private decodeTs(ptr: { i: number }, buf: Uint8Array, first: boolean): boolean {
    if (first) {
      if (ptr.i + 2 > buf.length) return false;
      this.ts16 = le16(buf, ptr.i);
      this.prevTs8 = this.ts16 & 0xff;
      ptr.i += 2;
    } else {
      if (ptr.i + 1 > buf.length) return false;
      const ts8 = buf[ptr.i++]!;
      if (ts8 < this.prevTs8) this.ts16 += 0x100;
      this.ts16 = (this.ts16 & 0xff00) | ts8;
      this.prevTs8 = ts8;
    }
    return true;
  }

  private decodeMsg(ibuf: Uint8Array): void {
    const recCnt = ibuf[1]!;
    const ptr = { i: MSG_HEADER_LEN };
    let recTsIdx = 0;

    for (let recIdx = 0; recIdx < recCnt; recIdx++) {
      if (ptr.i >= ibuf.length) break;
      const sl = ibuf[ptr.i++]!;

      if (sl & STATUSLEN_INTERNAL) {
        this.decodeStatus(ibuf, ptr, sl, recTsIdx === 0);
        if (sl & STATUSLEN_TIMESTAMP) recTsIdx++;
      } else {
        const frame = this.decodeData(ibuf, ptr, sl, recTsIdx === 0);
        if (sl & STATUSLEN_TIMESTAMP || true) {
          // decodeData always consumes a timestamp for data frames
          recTsIdx++;
        }
        if (frame) this.onFrame?.(frame);
      }
    }
  }

  private decodeStatus(
    buf: Uint8Array,
    ptr: { i: number },
    statusLen: number,
    firstTs: boolean
  ): void {
    const recLen = statusLen & STATUSLEN_DLC;
    if (ptr.i + 2 > buf.length) return;
    const f = buf[ptr.i]!;
    const n = buf[ptr.i + 1]!;
    ptr.i += 2; // PCAN_USB_CMD_ARGS offset

    if (statusLen & STATUSLEN_TIMESTAMP) {
      if (!this.decodeTs(ptr, buf, firstTs)) return;
    }

    switch (f) {
      case REC_ERROR:
        this.handleError(n);
        break;
      case REC_ANALOG:
        // skip 2
        break;
      case REC_BUSLOAD:
        break;
      case REC_TS:
        if (ptr.i + 2 <= buf.length) {
          this.ts16 = le16(buf, ptr.i);
        }
        break;
      case REC_BUSEVT:
        if (ptr.i + 3 <= buf.length) {
          this.bus.rxerr = buf[ptr.i + 1]!;
          this.bus.txerr = buf[ptr.i + 2]!;
          this.onStatus?.(this.bus);
        }
        break;
      default:
        break;
    }

    if (ptr.i + recLen <= buf.length) ptr.i += recLen;
    else ptr.i = buf.length;
  }

  private handleError(n: number): void {
    if (n & ERROR_RXQOVR) this.bus.rxOverflow = true;
    if (n & ERROR_BUS_OFF) {
      this.bus.busOff = true;
      this.bus.busHeavy = true;
    } else if (n & ERROR_BUS_HEAVY) {
      this.bus.busHeavy = true;
      this.bus.busOff = false;
    } else if (n & ERROR_BUS_LIGHT) {
      this.bus.busLight = true;
      this.bus.busHeavy = false;
      this.bus.busOff = false;
    } else {
      this.bus.busOff = false;
      this.bus.busHeavy = false;
      this.bus.busLight = false;
    }

    const parts: string[] = [];
    if (n & ERROR_BUS_OFF) parts.push("Bus-Off");
    if (n & ERROR_BUS_HEAVY) parts.push("Error Passive/Warning");
    if (n & ERROR_BUS_LIGHT) parts.push("Error Active(light)");
    if (n & ERROR_RXQOVR) parts.push("RX Overflow");
    if (n & ERROR_TXQFULL) parts.push("TX Queue Full");

    this.onFrame?.({
      id: 0,
      ext: false,
      rtr: false,
      dlc: 0,
      data: new Uint8Array(0),
      ts: this.ts16,
      dir: "rx",
      error: true,
      errorFlags: n,
      busState: parts.join(", ") || `err=0x${n.toString(16)}`,
    });
    this.onStatus?.(this.bus, parts.join(", ") || undefined);
  }

  private decodeData(
    buf: Uint8Array,
    ptr: { i: number },
    statusLen: number,
    firstTs: boolean
  ): CanFrame | null {
    const recLen = statusLen & STATUSLEN_DLC;
    let canIdFlags = 0;
    let id = 0;
    let ext = false;

    if (statusLen & STATUSLEN_EXT_ID) {
      if (ptr.i + 4 > buf.length) return null;
      canIdFlags = le32(buf, ptr.i);
      id = (canIdFlags >>> 3) & 0x1fffffff;
      ext = true;
      ptr.i += 4;
    } else {
      if (ptr.i + 2 > buf.length) return null;
      canIdFlags = le16(buf, ptr.i);
      id = (canIdFlags >>> 5) & 0x7ff;
      ptr.i += 2;
    }

    if (!this.decodeTs(ptr, buf, firstTs)) return null;

    const rtr = !!(statusLen & STATUSLEN_RTR);
    const data = new Uint8Array(rtr ? 0 : recLen);
    if (!rtr) {
      if (ptr.i + recLen > buf.length) return null;
      data.set(buf.subarray(ptr.i, ptr.i + recLen));
      ptr.i += recLen;
      if (canIdFlags & TX_SRR) {
        if (ptr.i < buf.length) ptr.i++;
      }
    }

    return {
      id,
      ext,
      rtr,
      dlc: recLen,
      data,
      ts: this.ts16,
      dir: "rx",
    };
  }

  cancelPending(): void { this.txGeneration++; }

  async sendFrame(frame: {
    id: number;
    ext?: boolean;
    rtr?: boolean;
    data?: Uint8Array | number[];
  }, valid: () => boolean = () => true): Promise<void> {
    // Queue TX so rapid button clicks never overlap transferOut
    const generation = this.txGeneration;
    const run = this.txChain.then(() => {
      if (generation !== this.txGeneration || !valid()) throw new Error("发送已取消");
      return this.sendFrameLocked(frame);
    });
    this.txChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async sendFrameLocked(frame: {
    id: number;
    ext?: boolean;
    rtr?: boolean;
    data?: Uint8Array | number[];
  }): Promise<void> {
    if (!this.device.opened || !this.running) {
      throw new Error("总线未打开");
    }
    const obuf = new Uint8Array(TX_BUFFER_SIZE);
    obuf[0] = MSG_TX_CAN;
    obuf[1] = 1;

    const data =
      frame.data instanceof Uint8Array
        ? frame.data
        : new Uint8Array(frame.data ?? []);
    const dlc = Math.min(8, data.length);
    const rtr = !!frame.rtr;
    const ext = !!frame.ext;

    let pc = MSG_HEADER_LEN;
    let sl = rtr ? 0 : dlc;
    if (rtr) sl |= STATUSLEN_RTR;
    if (ext) sl |= STATUSLEN_EXT_ID;
    obuf[pc] = sl;

    let canIdFlags = frame.id & (ext ? 0x1fffffff : 0x7ff);

    if (ext) {
      pc++;
      canIdFlags <<= 3;
      putLe32(obuf, pc, canIdFlags >>> 0);
      pc += 4;
    } else {
      pc++;
      canIdFlags <<= 5;
      putLe16(obuf, pc, canIdFlags & 0xffff);
      pc += 2;
    }

    if (!rtr) {
      obuf.set(data.subarray(0, dlc), pc);
      pc += dlc;
    }

    this.txSeq = (this.txSeq + 1) & 0xff;
    obuf[TX_BUFFER_SIZE - 1] = this.txSeq;

    await this.withTimeout(this.device.transferOut(EP_MSGOUT, obuf), 2000, "CAN 发送");

    this.onFrame?.({
      id: frame.id,
      ext,
      rtr,
      dlc: rtr ? 0 : dlc,
      data: data.subarray(0, dlc),
      dir: "tx",
    });
  }
}

export function webUsbFilters(): USBDeviceFilter[] {
  // Prioritize classic; also list other PEAK PIDs so picker shows them
  return KNOWN_PIDS.map((pid) => ({
    vendorId: PCAN_USB_VENDOR_ID,
    productId: pid,
  }));
}
