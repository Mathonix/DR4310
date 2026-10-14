import { AUDIO_STATES, AudioSession, audioReason, audioTestTone, audioAmplitudeMax } from "./audio";
import { prepareAudioFile } from "./audio-convert";
type Host = {
  ready(): boolean; connected(): boolean; baud(): number; firmwareBaud(): number | undefined; pendingEdits(): boolean;
  amplitudeCapability(axis: "Q" | "D"): number | undefined;
  prepare(): Promise<void>; command(line: string): Promise<Record<string, string>>;
  write(bytes: Uint8Array): Promise<void>; cancelWrites(): void;
  receiver(fn: ((chunk: Uint8Array) => void) | null): void;
  recover(): Promise<void>; refresh(): void; toast(text: string, kind?: "" | "ok" | "err"): void;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
export function createAudioPanel(h: Host) {
  let busy = false, cancelled = false, session: AudioSession | null = null, originalTelem: number | null = null;
  let pcm: Uint8Array | null = null, samples = 0, downloadName = "", loading = false, loadGeneration = 0;
  let lastMax = 0, cleanTask: Promise<boolean> | null = null;
  function refresh(): void {
    const ready = h.ready() && [200000,230400].includes(h.baud()) && h.firmwareBaud() === h.baud();
    const axis = $<HTMLSelectElement>("audioAxis").value as "Q" | "D";
    const max = audioAmplitudeMax(axis, h.amplitudeCapability(axis));
    const amp = $<HTMLInputElement>("audioAmp"), range = $<HTMLInputElement>("audioAmpRange");
    amp.max = range.max = String(max);
    if (max !== lastMax) {
      const value = Number(amp.value);
      amp.value = String(Math.min(max, Math.max(1, Number.isInteger(value) ? value : 5)));
      lastMax = max;
    }
    const amplitude = Number(amp.value), validAmplitude = Number.isInteger(amplitude) && amplitude >= 1 && amplitude <= max;
    if (validAmplitude) range.value = amp.value;
    $("audioAmpLimit").textContent = `可调 1–${max} mA · ${axis === "Q" ? "Q 轴转矩电流" : "D 轴磁链电流"}`;
    $<HTMLFieldSetElement>("audioInputs").disabled = busy || !ready;
    $<HTMLFieldSetElement>("audioFileInputs").disabled = busy || loading;
    $("audioDownload").toggleAttribute("disabled", !pcm || busy || loading);
    const safe = $<HTMLInputElement>("audioReady").checked;
    $("audioPlay").toggleAttribute("disabled", busy || loading || !ready || !safe || !pcm || !validAmplitude);
    $("audioTest").toggleAttribute("disabled", busy || loading || !ready || !safe || !validAmplitude);
    $("audioStop").toggleAttribute("disabled", !busy);
    $("audioPause").toggleAttribute("disabled", !busy || !session?.sid || ![1, 2, 3].includes(session.status?.state ?? -1));
    $("audioPause").textContent = session?.status?.state === 2 ? "继续" : "暂停";
    $("audioHint").textContent = busy ? `音频独占串口，${session?.lowTx ? "短 TX 模式已生效（100 ms 状态回传）" : "标准 TX 模式"}。请保持页面在前台。` : ready ? `${axis} 轴峰值上限 ${max} mA。先做小幅短测，再播放文件；停止与 Esc 均可中止。` : "连接与固件匹配的 200000 或 230400 串口后可用。";
    if (session?.status) {
      const s = session.status;
      $<HTMLProgressElement>("audioProgress").value = samples ? 100 * s.played / samples : 0;
      $("audioStats").textContent = `${(s.played / 8000).toFixed(2)} / ${(samples / 8000).toFixed(2)} s · 缓冲 ${s.buffer}/${session.capacity} · ACK ${s.ack} · 欠载 ${s.underruns} · 重传 ${session.retries} · 坏帧 ${session.parser.rejected}`;
      if (busy && !cancelled) $("audioStatus").textContent = `${AUDIO_STATES[s.state]} · ${audioReason(s)}`;
    }
  }
  function check(): void { if (cancelled || !h.connected() || document.visibilityState === "hidden") throw new Error("音频操作已取消或连接断开"); }
  async function cmd(line: string): Promise<Record<string, string>> { check(); const r = await h.command(line); check(); return r; }
  function abort(reason: string): void { if (!busy) return; cancelled = true; session?.cancel(); $("audioStatus").textContent = reason; }
  function cleanup(): Promise<boolean> {
    if (cleanTask) return cleanTask;
    cleanTask = (async () => {
      const exited = await session?.exit() ?? true;
      if (!h.connected()) return false;
      if (!exited) { $("audioStatus").textContent = "等待看门狗并重连确认停机…"; await h.recover(); }
      h.receiver(null);
      await h.command("STOP\n");
      if (originalTelem !== null) await h.command(`SET TELEM ${originalTelem}\n`);
      const info = await h.command("INFO\n");
      if (info.run !== "IDLE" || info.drv !== "0" || info.ae !== "0") throw new Error("停机未确认，请使用硬件急停");
      return true;
    })();
    return cleanTask;
  }
  async function stop(reason: string): Promise<boolean> { abort(reason); return cleanup(); }
  async function start(test: boolean): Promise<void> {
    if (busy || loading || !h.ready() || !$<HTMLInputElement>("audioReady").checked) return;
    if (h.pendingEdits()) { h.toast("请先写入或撤回尚未提交的参数修改", "err"); return; }
    const amplitude = Number($<HTMLInputElement>("audioAmp").value), axis = $<HTMLSelectElement>("audioAxis").value as "Q" | "D";
    const max = audioAmplitudeMax(axis, h.amplitudeCapability(axis));
    if (!Number.isInteger(amplitude) || amplitude < 1 || amplitude > max) { h.toast(`${axis} 轴幅度须为 1–${max} mA 的整数`, "err"); return; }
    const bytes = test ? audioTestTone() : pcm;
    if (!bytes) return;
    busy = true; cancelled = false; cleanTask = null; originalTelem = null; samples = bytes.length / 2;
    session = new AudioSession({ write: h.write, cancel: h.cancelWrites, connected: h.connected, now: () => performance.now(), sleep, changed: () => refresh() });
    refresh(); h.refresh(); $("audioStatus").textContent = "停机并准备音频…";
    let success = false, failure = "";
    try {
      await h.prepare(); check();
      const initial = await cmd("INFO\n");
      if (initial.audio !== "1" || Number(initial.uart_baud) !== h.baud() || ![200000,230400].includes(h.baud()) || initial.calib !== "1" || Number(initial.fault) || Number(initial.latched)) throw new Error("固件能力、校准或安全状态不满足 AUDIO 要求");
      const verifiedMax = audioAmplitudeMax(axis, Number(initial[axis === "Q" ? "audio_qmax_ma" : "audio_dmax_ma"]));
      if (amplitude > verifiedMax) throw new Error(`${axis} 轴固件峰值上限为 ${verifiedMax} mA`);
      originalTelem = Number(initial.telem);
      if (![0, 1].includes(originalTelem)) throw new Error("无法读取原遥测状态");
      await cmd("TELEM 0\n"); await cmd("AE 0\n"); await cmd("RUN\n"); await cmd("IQ 0\n");
      await sleep(100); check(); const current = await cmd("INFO\n");
      if (current.run !== "CURRENT" || current.drv !== "1" || current.ae !== "0" || Number(current.fault) || Number(current.latched)) throw new Error("零电流模式未就绪");
      h.receiver(chunk => session?.receive(chunk));
      await session.open(axis, test ? Math.min(5, amplitude) : amplitude); check();
      await session.play(bytes); success = true;
    } catch (e) { failure = message(e); }
    finally {
      try { if (!(await cleanup())) failure ||= "串口已断开；电机由音频看门狗停止，请重新连接确认"; }
      catch (e) { failure = `停机/恢复失败：${message(e)}`; }
      h.receiver(null); busy = false;
      $("audioStatus").textContent = failure || (success ? "播放完成 · 已确认停机，遥测已恢复" : "已停止");
      h.toast(failure || "音频播放完成，电机已停止", failure ? "err" : "ok");
      refresh(); h.refresh();
    }
  }
  function init(): void {
    $("audioReady").addEventListener("change", refresh);
    $("audioAxis").addEventListener("change", refresh);
    $("audioAmp").addEventListener("input", refresh);
    $("audioAmpRange").addEventListener("input", () => {
      $<HTMLInputElement>("audioAmp").value = $<HTMLInputElement>("audioAmpRange").value; refresh();
    });
    $("audioPlay").addEventListener("click", () => void start(false));
    $("audioTest").addEventListener("click", () => void start(true));
    $("audioStop").addEventListener("click", () => void stop("用户停止").catch(e => h.toast(message(e), "err")));
    $("audioPause").addEventListener("click", () => { if (session) void (session.status?.state === 2 ? session.resume() : session.pause()).catch(e => { abort(message(e)); }); });
    $("audioFile").addEventListener("change", async event => {
      const file = (event.target as HTMLInputElement).files?.[0]; if (!file || busy) return;
      const generation = ++loadGeneration;
      pcm = null; samples = 0; loading = true;
      $<HTMLProgressElement>("audioProgress").value = 0;
      $("audioFileInfo").textContent = `正在读取并转换 ${file.name}…`;
      refresh();
      try {
        const prepared = await prepareAudioFile(file); if (busy || generation !== loadGeneration) return;
        pcm = prepared.bytes; samples = prepared.samples; downloadName = prepared.downloadName;
        session = null;
        $("audioFileInfo").textContent = `${file.name} · ${(samples / 8000).toFixed(2)} s · ${samples} 样本 · ${prepared.converted ? `已转换（${prepared.sourceChannels} 声道 → 单声道）` : "RAW 已就绪"} · 8000 Hz / S16LE · 已去除直流偏置`;
        $("audioStatus").textContent = "文件已就绪，可下载 RAW 或连接电机播放";
        $("audioStats").textContent = `${(samples / 8000).toFixed(2)} s · ${(pcm.length / 1024).toFixed(1)} KiB · 播放进度依据电机已消费的样本更新`;
      } catch (e) {
        if (generation !== loadGeneration) return;
        pcm = null; $("audioFileInfo").textContent = message(e); h.toast(message(e), "err");
      } finally { if (generation === loadGeneration) { loading = false; refresh(); } }
    });
    $("audioDownload").addEventListener("click", () => {
      if (!pcm || busy || loading) return;
      const url = URL.createObjectURL(new Blob([new Uint8Array(pcm).buffer], { type: "application/octet-stream" }));
      const link = document.createElement("a"); link.href = url; link.download = downloadName;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    refresh();
  }
  return { init, refresh, abort, stop, get busy() { return busy; }, get binary() { return session?.binary ?? false; } };
}
