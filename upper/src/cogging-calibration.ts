/** Browser-side calibration over the existing UART protocol. No cloud device I/O. */
export const COG_SIZE = 512;
const TAU = Math.PI * 2;
export const COG_CHANNELS = ["EncRad", "Iq", "IqRef", "Omega", "Fault", "Mode", "Vbus", "CogIq", "Id", "Vsat", "Ia", "Ib", "Ic", "DutyA", "DutyB", "DutyC"];
export type CogBinding = { zero: number; dir: number; pp: number };
export type CogMap = {
  type: "dr4310-cogging"; version: 1; angle: "raw_encoder_rad";
  binding: CogBinding; motor_id: number; current_ma: number[]; crc32: string;
  quality?: { samples: number; min_samples_per_bin: number; removed_dc_a: number; peak_a: number; direction_difference_rms_a: number; speed_rad_s: number };
};
export type CogOptions = { speed: number; currentLimit: number; turns: number };
export type CogProgress = { phase: string; percent: number; turns?: number; direction?: number; samples?: number };
export type CogReply = { kv: Record<string, string>; text: string };
export type CogDriver = {
  current(): boolean;
  command(line: string, timeout?: number): Promise<CogReply>;
  params(): Promise<Record<string, number>>;
  subscribe(listener: (frame: Float32Array, now: number) => void): () => void;
  channels(names: string[], hz: number): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  progress(state: CogProgress): void;
};

const finite = (n: number) => Number.isFinite(n);
const error = (message: string): never => { throw new Error(message); };
const number = (v: string | undefined) => v === undefined ? NaN : Number(v);
const sameBinding = (a: CogBinding, b: CogBinding) => a.dir === b.dir && a.pp === b.pp && Math.abs(a.zero-b.zero) <= 1e-5;
export function cogBinding(kv: Record<string, string>): CogBinding {
  const b = { zero: number(kv.zero), dir: number(kv.dir), pp: number(kv.pp) };
  if (!finite(b.zero) || b.zero < 0 || b.zero >= TAU || ![0, 1].includes(b.dir) || !Number.isInteger(b.pp) || b.pp < 1 || b.pp > 40) error("无法确认电角度校准信息");
  return b;
}
export function cogCrc(values: readonly number[]): string {
  const bytes = new Uint8Array(values.length * 2), view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setInt16(i*2, value, true));
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((~crc) >>> 0).toString(16).padStart(8, "0");
}
export function validateCogMap(value: unknown): CogMap {
  if (!value || typeof value !== "object") error("补偿文件格式无效");
  const m = value as CogMap;
  if (m.type !== "dr4310-cogging" || m.version !== 1 || m.angle !== "raw_encoder_rad" ||
      !Array.isArray(m.current_ma) || m.current_ma.length !== COG_SIZE ||
      m.current_ma.some(v => !Number.isInteger(v) || Math.abs(v) > 1000) ||
      !Number.isInteger(m.motor_id) || m.motor_id < 1 || m.motor_id > 7) error("需要 512 点、±1000 mA 范围的齿槽补偿文件");
  if (!m.binding || !sameBinding(m.binding, cogBinding(Object.fromEntries(Object.entries(m.binding).map(([k,v]) => [k,String(v)]))))) error("文件校准信息无效");
  if (Math.abs(m.current_ma.reduce((a,b) => a+b, 0) / COG_SIZE) > 2) error("补偿表含有直流偏置");
  if (m.crc32?.toLowerCase() !== cogCrc(m.current_ma)) error("补偿表 CRC 校验失败");
  // Copy caller-owned data; a later file/UI edit must not change an upload.
  return { ...m, binding: { ...m.binding }, current_ma: [...m.current_ma] };
}
export function validateCogOptions(o: CogOptions): void {
  if (!finite(o.speed) || o.speed < .05 || o.speed > .5 || !finite(o.currentLimit) || o.currentLimit < .02 || o.currentLimit > 1 || !Number.isInteger(o.turns) || o.turns < 2 || o.turns > 10) error("速度须为 0.05–0.5 rad/s，限流 0.02–1 A，圈数为 2–10 的整数");
}

/** Streaming bins keep memory bounded even for ten very slow revolutions. */
export class CoggingFit {
  private sum = [new Float64Array(COG_SIZE), new Float64Array(COG_SIZE)];
  private count = [new Uint32Array(COG_SIZE), new Uint32Array(COG_SIZE)];
  samples = 0;
  add(direction: number, angle: number, iq: number): void {
    if (![1,-1].includes(direction) || !finite(angle) || !finite(iq) || Math.abs(iq) > 1) error("标定采样无效");
    const x = ((angle % TAU) + TAU) % TAU;
    const i = Math.floor(x*COG_SIZE/TAU + .5) % COG_SIZE, side = direction === 1 ? 0 : 1;
    this.sum[side]![i]! += iq; this.count[side]![i]!++; this.samples++;
  }
  finish(binding: CogBinding, motorId: number, speed: number): CogMap {
    const means = [new Float64Array(COG_SIZE), new Float64Array(COG_SIZE)];
    let minimum = Infinity, missing = 0;
    for (let side = 0; side < 2; side++) for (let i = 0; i < COG_SIZE; i++) {
      const n = this.count[side]![i]!;
      minimum = Math.min(minimum, n);
      if (n < 4) missing++;
      means[side]![i] = n ? this.sum[side]![i]! / n : 0;
    }
    if (missing) error(`${missing} 个方向/角度点样本不足，未生成补偿表。可降低速度或增加圈数重试`);
    const avg = Array.from({ length: COG_SIZE }, (_, i) => (means[0]![i]! + means[1]![i]!) / 2);
    const dc = avg.reduce((a,b) => a+b, 0) / COG_SIZE;
    const values = avg.map(v => Math.round((v-dc)*1000));
    return validateCogMap({ type: "dr4310-cogging", version: 1, angle: "raw_encoder_rad", motor_id: motorId,
      binding, current_ma: values, crc32: cogCrc(values), quality: { samples: this.samples,
        min_samples_per_bin: minimum, removed_dc_a: dc, peak_a: Math.max(...values.map(Math.abs))/1000,
        direction_difference_rms_a: Math.sqrt(means[0]!.reduce((a,v,i) => a+(v-means[1]![i]!)**2,0)/COG_SIZE), speed_rad_s: speed } });
  }
}

type Snapshot = { params: Record<string, number>; names: string[]; rate: number; binding: CogBinding; id: number };
export class CoggingCalibration {
  private controller: AbortController | null = null;
  backup: CogMap | null = null;
  get active(): boolean { return this.controller !== null; }
  cancel(reason = "标定已停止"): void { this.controller?.abort(reason); }
  constructor(private d: CogDriver) {}
  private check(): void {
    if (this.controller?.signal.aborted) error(String(this.controller.signal.reason || "已停止"));
    if (!this.d.current()) error("串口连接已变化，操作已取消");
  }
  private async command(line: string, timeout = 1000): Promise<CogReply> {
    this.check(); const reply = await this.d.command(line+"\n", timeout); this.check(); return reply;
  }
  private async stop(): Promise<void> {
    // Cleanup deliberately ignores cancellation, but never writes a new session.
    if (!this.d.current()) error("串口已断开，等待设备通信超时停机");
    await this.d.command("STOP\n", 700);
    for (let i = 0; i < 5; i++) {
      const r = await this.d.command("INFO\n", 700);
      if (r.kv.run === "IDLE" && r.kv.drv === "0" && r.kv.ae === "0") return;
      await this.d.sleep(20);
    }
    error("设备未确认停机，未恢复参数");
  }
  private async snapshot(): Promise<Snapshot> {
    await this.stop(); this.check();
    const info = (await this.command("INFO")).kv;
    if (info.fw !== "DR4310" || info.calib !== "1" || number(info.fault) !== 0 || number(info.latched) !== 0 || !finite(number(info.vbus)) || number(info.vbus) < 6 || number(info.vbus) > 40) error("先完成电角度校准并排除故障，确认电机供电正常");
    const c = (await this.command("COG INFO")).kv;
    if (c.size !== "512") error("当前固件不支持 512 点齿槽补偿");
    const p = await this.d.params(); this.check();
    if (["IQ_LIM","TELEM","COG_EN","COG_GAIN","COG_LIM","OL_EN","SPD_RAMP_MS","TIMEOUT_MS"].some(k => !finite(p[k]!))) error("参数读取不完整，操作已取消");
    const names = (await this.command("TCH")).text.split(",").map(n => n.trim());
    const rate = number((await this.command("TRATE")).kv.hz);
    if (names.length !== 16 || names.some(n => !/^[A-Za-z]\w*$/.test(n)) || !finite(rate) || rate < 10) error("无法备份遥测配置");
    return { params: p, names, rate, binding: cogBinding(c), id: number(info.id) };
  }
  private async restore(s: Snapshot, enabled = s.params.COG_EN!): Promise<void> {
    await this.stop();
    await this.d.command("SET TELEM 0\n");
    for (const key of ["IQ_LIM", "OL_EN", "SPD_RAMP_MS", "COG_EN"])
      await this.d.command(`SET ${key} ${key === "COG_EN" ? enabled : s.params[key]}\n`);
    await this.d.command(`TCH ${s.names.join(" ")}\n`);
    await this.d.command(`TRATE ${s.rate}\n`);
    this.d.channels(s.names, s.rate);
    // TIMEOUT_MS is restored only after STOP/INFO confirmed driver off.
    await this.d.command(`SET TIMEOUT_MS ${s.params.TIMEOUT_MS}\n`);
    await this.d.command(`SET TELEM ${s.params.TELEM}\n`);
  }
  async calibrate(options: CogOptions): Promise<CogMap> {
    validateCogOptions(options);
    if (this.active) error("已有标定操作正在进行");
    this.controller = new AbortController();
    let s: Snapshot | null = null, outcome: CogMap | null = null, failure: unknown;
    try {
      this.d.progress({ phase: "准备与备份", percent: 0 });
      s = await this.snapshot();
      const limit = Math.min(options.currentLimit, s.params.IQ_LIM!);
      if (limit < .02) error("现有最大电流低于 0.02 A，无法标定");
      for (const [key, val] of Object.entries({ TELEM: 0, COG_EN: 0, OL_EN: 0, IQ_LIM: limit, TIMEOUT_MS: 1000, SPD_RAMP_MS: 0 })) await this.command(`SET ${key} ${val}`);
      await this.command(`TCH ${COG_CHANNELS.join(" ")}`);
      const read = await this.command("TCH");
      if (read.text.split(",").map(s => s.trim()).join(" ") !== COG_CHANNELS.join(" ")) error("标定遥测通道未正确切换");
      // 200 Hz fits 230400 8N1 and improves coverage at every encoder knot.
      await this.command("TRATE 200"); this.d.channels(COG_CHANNELS, 200);
      await this.command("SET TELEM 1");
      const fit = new CoggingFit();
      for (const sign of [1,-1]) await this.scan(sign, options, limit, s.binding.dir, fit);
      this.d.progress({ phase: "计算补偿表", percent: 98, samples: fit.samples });
      outcome = fit.finish(s.binding, s.id, options.speed);
    } catch (e) { failure = e; }
    try { if (s && this.d.current()) await this.restore(s); else if (this.d.current()) await this.stop(); }
    catch (e) { failure = new Error(`停机/参数恢复未完成：${e instanceof Error ? e.message : String(e)}`); }
    finally { this.controller = null; }
    if (failure) throw failure;
    if (!outcome) throw new Error("标定未完成");
    this.d.progress({ phase: "补偿表已生成 · 尚未写入设备", percent: 100, samples: outcome.quality!.samples });
    return outcome;
  }
  private async scan(sign: number, o: CogOptions, limit: number, dir: number, fit: CoggingFit): Promise<void> {
    const frames: { frame: Float32Array; now: number }[] = [];
    const unsubscribe = this.d.subscribe((frame, now) => frames.push({ frame, now }));
    const start = this.d.now(), deadline = start + 6000 + 1600*o.turns*TAU/o.speed;
    let last = start, ping = start, bad = 0, saturatedAt = 0, previous: number | null = null, travel = 0;
    const velocity: { now: number; value: number }[] = [];
    try {
      await this.command(`SPD ${sign*o.speed*60/TAU}`);
      while (travel < o.turns*TAU) {
        this.check(); const now = this.d.now();
        if (now > deadline) error("扫描超时，电机可能未正常转动");
        if (frames.length > 4096) error("遥测处理积压，标定已停止");
        while (frames.length) {
          const item = frames.shift()!, f = item.frame, t = item.now;
          last = t;
          if (f.length !== 16 || Array.from(f).some(v => !finite(v))) error("遥测数据无效");
          const angle=f[0]!, iq=f[1]!, ref=f[2]!, omega=f[3]!;
          if (f[4] !== 0) error("设备报告故障，标定已停止");
          if (angle < 0 || angle >= TAU+1e-5 || Math.abs(omega)>Math.max(.8,2*o.speed) || Math.abs(ref)>limit+.001 || Math.max(Math.abs(f[10]!),Math.abs(f[11]!),Math.abs(f[12]!))>.6 || f[6]!<6 || f[6]!>40) error("速度、电流或供电超出标定范围");
          velocity.push({now:t,value:omega}); while (velocity.length && velocity[0]!.now<t-100) velocity.shift();
          const mean=velocity.reduce((a,v)=>a+v.value,0)/velocity.length;
          if (t-start<3000) { previous=null; continue; }
          if (f[5]!==2) error("设备离开速度模式，标定已停止");
          const good=.75*o.speed<=sign*mean && sign*mean<=1.25*o.speed;
          bad=good?0:(bad||t);
          const saturated=Math.abs(ref)>=.95*limit || f[9]!>=.5;
          saturatedAt=saturated?(saturatedAt||t):0;
          if (bad && t-bad>800) error("低速跟踪不稳定或失速，请先检查速度环");
          if (saturatedAt && t-saturatedAt>300) error("电流或电压饱和，未生成补偿表");
          if (previous!==null) {
            let delta=angle-previous; if (delta>Math.PI) delta-=TAU; if (delta<-Math.PI) delta+=TAU;
            travel+=sign*(dir===1?delta:-delta);
          }
          previous=angle;
          if (good && !saturated) fit.add(sign,angle,iq);
        }
        if (now-last>500) error("遥测中断，标定已停止");
        if (now>=ping) { await this.command("PING",500); ping=this.d.now()+200; }
        this.d.progress({ phase: sign===1?"正向扫描":"反向扫描", direction:sign, turns:Math.max(0,travel/TAU),
          percent:2+(sign===1?0:48)+Math.min(48,48*travel/(o.turns*TAU)), samples:fit.samples });
        await this.d.sleep(10);
      }
      await this.stop();
    } finally { unsubscribe(); }
  }
  private async writeMap(m: CogMap, label: string): Promise<void> {
    await this.command("COG BEGIN");
    for (let i=0;i<COG_SIZE;i+=16) {
      await this.command(`COG SET ${i} ${m.current_ma.slice(i,i+16).join(" ")}`);
      this.d.progress({phase:label,percent:40+50*(i+16)/COG_SIZE});
    }
    await this.command("COG COMMIT");
    const c=(await this.command("COG INFO")).kv;
    if (c.valid!=="1" || c.match!=="1" || number(c.crc)!==parseInt(m.crc32,16) || c.enabled!=="0") error("上传补偿表校验失败");
  }
  async upload(value: CogMap): Promise<void> {
    const map=validateCogMap(value);
    if (this.active) error("已有标定操作正在进行");
    this.controller=new AbortController(); this.backup=null;
    let s:Snapshot|null=null, began=false, saveSent=false, saved=false, failure:unknown;
    try {
      this.d.progress({phase:"核对设备与备份",percent:0});
      s=await this.snapshot();
      if (s.id!==map.motor_id || !sameBinding(s.binding,map.binding)) error("补偿表与当前电机/电角度校准不匹配");
      const old=(await this.command("COG INFO")).kv;
      await this.command("SET TELEM 0");
      if (old.valid==="1" && old.match==="1") {
        const values:number[]=[];
        for (let i=0;i<COG_SIZE;i++) {
          const r=(await this.command(`COG GET ${i}`)).kv, ma=number(r.ma);
          if (number(r.index)!==i || !Number.isInteger(ma) || Math.abs(ma)>1000) error("原补偿表备份失败");
          values.push(ma); this.d.progress({phase:"备份原补偿表",percent:40*(i+1)/COG_SIZE});
        }
        if (parseInt(cogCrc(values),16)!==number(old.crc)) error("原补偿表备份 CRC 不一致");
        this.backup={type:"dr4310-cogging",version:1,angle:"raw_encoder_rad",binding:s.binding,motor_id:s.id,current_ma:values,crc32:cogCrc(values)};
      }
      began=true; await this.writeMap(map,"上传补偿表");
      await this.command(`SET TELEM ${s.params.TELEM}`);
      saveSent=true; await this.command("SAVE",5000);
      await this.command("RELOAD");
      const back=(await this.command("COG INFO")).kv;
      if (back.valid!=="1" || back.match!=="1" || back.enabled!=="0" || number(back.crc)!==parseInt(map.crc32,16)) error("Flash 回读校验失败");
      saved=true;
    } catch(e) { failure=e; }
    try {
      if (s && this.d.current()) {
        await this.stop();
        if (failure && began) {
          // Before SAVE the old flash is intact. After a lost SAVE reply, RELOAD
          // determines the actual persisted state without guessing or enabling.
          await this.d.command("COG ABORT\n");
          if (!saveSent && this.backup) {
            this.controller=new AbortController();
            await this.writeMap(this.backup,"恢复原补偿表");
          } else await this.d.command("RELOAD\n");
        }
        await this.restore(s, saved || saveSent ? 0 : s.params.COG_EN!);
      }
    } catch(e) { failure=new Error(`上传/恢复未完成：${e instanceof Error?e.message:String(e)}`); }
    finally { this.controller=null; }
    if (failure) throw failure;
    this.d.progress({phase:"补偿表已保存并校验 · 补偿关闭",percent:100});
  }
  async enable(): Promise<void> {
    if(this.active) error("已有标定操作正在进行");
    this.controller=new AbortController();
    let s: Snapshot | null = null, done = false;
    try {
      s=await this.snapshot(); const c=(await this.command("COG INFO")).kv;
      if(c.valid!=="1" || c.match!=="1") error("当前没有匹配的有效补偿表");
      await this.command("SET TELEM 0"); await this.command("SET COG_EN 1");
      await this.command(`SET TELEM ${s.params.TELEM}`); await this.command("SAVE",5000);
      const r=(await this.command("COG INFO")).kv;
      if(r.enabled!=="1") error("补偿启用未确认");
      done=true;
      this.d.progress({phase:"齿槽补偿已启用并保存",percent:100});
    } finally { try { if(s) await this.restore(s, done ? 1 : 0); else await this.stop(); } finally { this.controller=null; } }
  }
}
