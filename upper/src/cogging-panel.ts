import { CoggingCalibration, validateCogMap, validateCogOptions, type CogDriver, type CogMap, type CogProgress } from "./cogging-calibration";

type Host = {
  driver(): CogDriver;
  ready(): boolean;
  pendingEdits(): boolean;
  prepare(): Promise<void>;
  stop(): Promise<void>;
  changed(driver: CogDriver): Promise<void>;
  refresh(): void;
  toast(text: string, kind?: "" | "ok" | "err"): void;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
export function createCoggingPanel(h: Host) {
  let busy = false, token = 0, engine: CoggingCalibration | null = null, map: CogMap | null = null, backup: CogMap | null = null;
  let progressAt = 0, progressPhase = "";
  function progress(p: CogProgress): void {
    const now=performance.now();
    if(p.phase===progressPhase && p.percent<100 && now-progressAt<200) return;
    progressAt=now; progressPhase=p.phase;
    $<HTMLProgressElement>("cogProgress").value = p.percent;
    $("cogStatus").textContent = p.phase + (p.turns === undefined ? "" : ` · ${p.turns.toFixed(2)} 圈`) + (p.samples === undefined ? "" : ` · ${p.samples} 个样本`);
  }
  function renderMap(): void {
    if (!map) return;
    const peak = Math.max(...map.current_ma.map(Math.abs));
    $("cogResult").textContent = `512 点 · 峰值 ${peak} mA · CRC ${map.crc32}` + (map.quality ? ` · 每方向每点最少 ${map.quality.min_samples_per_bin} 个样本` : " · 已导入");
    const scale = Math.max(10, peak), points = map.current_ma.map((v,i) => `${(i/511*600).toFixed(1)},${(65-v/scale*55).toFixed(1)}`).join(" ");
    $("cogCurve").innerHTML = `<svg viewBox="0 0 600 135" role="img" aria-label="机械角度与补偿电流曲线" style="width:100%;height:auto"><path d="M0 65H600" stroke="currentColor" opacity=".3"/><polyline points="${points}" fill="none" stroke="var(--accent,#3498db)" stroke-width="1.5"/><text x="0" y="132" fill="currentColor" font-size="11">0°</text><text x="570" y="132" fill="currentColor" font-size="11">360°</text></svg>`;
  }
  function refresh(): void {
    if (!$("cogPanel")) return;
    const ready = h.ready();
    $<HTMLFieldSetElement>("cogInputs").disabled = busy || !ready;
    $("cogStart").toggleAttribute("disabled", busy || !ready || !$<HTMLInputElement>("cogReady").checked);
    $("cogStop").toggleAttribute("disabled", !busy);
    $("cogUpload").toggleAttribute("disabled", busy || !ready || !map);
    $("cogEnable").toggleAttribute("disabled", busy || !ready);
    $("cogImport").toggleAttribute("disabled", busy);
    $("cogExport").toggleAttribute("disabled", !map);
    $("cogBackup").toggleAttribute("disabled", !backup);
    $("cogHint").textContent = busy ? "标定操作进行中，其他运动和参数操作已锁定。请保持此页面在前台。" : ready ? "标定完成后先检查曲线，再上传保存，最后启用补偿。保存时会一并保存当前设备参数。" : "连接串口并读取参数后可用，需要支持齿槽补偿的 v3.3.0 或更高固件。";
  }
  function abort(reason: string): void { token++; engine?.cancel(reason); }
  async function operate(kind: "calibrate" | "upload" | "enable"): Promise<void> {
    if (busy || !h.ready()) return;
    if (h.pendingEdits()) { h.toast("请先写入或撤回尚未提交的参数修改", "err"); return; }
    const options = { speed:Number($<HTMLInputElement>("cogSpeed").value), currentLimit:Number($<HTMLInputElement>("cogLimit").value), turns:Number($<HTMLInputElement>("cogTurns").value) };
    try { if(kind === "calibrate") { validateCogOptions(options); if(!$<HTMLInputElement>("cogReady").checked) return; } }
    catch(e) { h.toast(message(e), "err"); return; }
    const mine = ++token, driver = h.driver();
    busy = true; engine = new CoggingCalibration({...driver, progress}); refresh(); h.refresh();
    try {
      progress({phase:"停机并接管串口",percent:0});
      await h.prepare();
      if (mine !== token || !driver.current() || document.visibilityState === "hidden") throw new Error("操作已取消");
      if (kind === "calibrate") { map = await engine.calibrate(options); renderMap(); h.toast("双向标定完成，补偿表尚未写入设备", "ok"); }
      else if(kind === "upload") { if(!map) throw new Error("请先标定或导入补偿表"); await engine.upload(map); backup=engine.backup; h.toast("补偿表已保存并回读校验，点击启用补偿后生效", "ok"); }
      else { await engine.enable(); h.toast("齿槽补偿已启用并保存", "ok"); }
    } catch(e) {
      backup=engine?.backup ?? backup;
      progress({phase:message(e),percent:$<HTMLProgressElement>("cogProgress").value}); h.toast(message(e), "err");
    } finally {
      engine=null;
      try { if(driver.current()) await h.changed(driver); }
      catch(e) { h.toast(`参数回读失败：${message(e)}`, "err"); }
      finally { busy=false; refresh(); h.refresh(); }
    }
  }
  function download(value: CogMap | null, suffix: string): void {
    if(!value) return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+"\n"],{type:"application/json"}));
    const a=document.createElement("a"); a.href=url; a.download=`motor-${value.motor_id}-cogging-${suffix}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function init(): void {
    if(!$("cogPanel")) return;
    $("cogStart").addEventListener("click",()=>void operate("calibrate"));
    $("cogStop").addEventListener("click",()=> { abort("用户停止标定"); void h.stop(); });
    $("cogUpload").addEventListener("click",()=>void operate("upload"));
    $("cogEnable").addEventListener("click",()=>void operate("enable"));
    $("cogReady").addEventListener("change",refresh);
    $("cogExport").addEventListener("click",()=>download(map,"map"));
    $("cogBackup").addEventListener("click",()=>download(backup,"backup"));
    $("cogImport").addEventListener("click",()=> $<HTMLInputElement>("cogFile").click());
    $("cogFile").addEventListener("change",async e=> {
      const input=e.target as HTMLInputElement, file=input.files?.[0]; input.value="";
      if(!file || busy) return;
      const mine=token;
      try {
        if(file.size>100000) throw new Error("补偿文件过大");
        const value=validateCogMap(JSON.parse(await file.text()));
        if(busy || token!==mine) return;
        map=value; renderMap(); progress({phase:"补偿表已导入 · 尚未写入设备",percent:100}); refresh();
      } catch(e) { h.toast(message(e),"err"); }
    });
    refresh();
  }
  return {init,refresh,abort,get busy(){return busy;}};
}
