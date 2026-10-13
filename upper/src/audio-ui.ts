import { loadAudioFile, type AudioInput } from "./audio-file";
import { AUDIO_REASON } from "./audio-protocol";
import type { AudioSnapshot } from "./audio-session";

type Host = {
  start(audio: AudioInput, axis: "Q" | "D", ampMa: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  connected(): boolean;
  firmware(): string;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const fmt = (n: number) => n.toLocaleString("zh-CN");
const duration = (seconds: number) => seconds.toFixed(2) + " s";
const stateNames: Record<AudioSnapshot["phase"], string> = {
  DISCONNECTED: "未连接", ASCII_READY: "待机", OPENING: "打开会话", BUFFERING: "预缓冲",
  PLAYING: "正在播放", PAUSED: "已暂停", DRAINING: "尾部播放", FINISHED: "播放完成",
  HALTED: "已停止", FAULT: "异常（需确认停机）", CLOSING: "安全退出",
};

export function initAudioUI(host: Host) {
  let audio: AudioInput | null = null;
  let loading = false, active = false;
  let current: AudioSnapshot | null = null;
  const input = $<HTMLInputElement>("audioFile");

  function render(): void {
    const connected = host.connected();
    $("audioLink").textContent = (connected ? "UART 已连接" : "UART 未连接") + " · " + host.firmware();
    const play = $<HTMLButtonElement>("audioPlay");
    play.disabled = loading || !audio || !connected || active;
    $<HTMLButtonElement>("audioPause").disabled = !active || current?.phase !== "PLAYING" && current?.phase !== "BUFFERING" && current?.phase !== "DRAINING";
    $<HTMLButtonElement>("audioResume").disabled = !active || current?.phase !== "PAUSED";
    $<HTMLButtonElement>("audioStop").disabled = !active;
    input.disabled = active;
    $<HTMLSelectElement>("audioAxis").disabled = active;
    $<HTMLInputElement>("audioAmp").disabled = active;
    if (!current) return;
    $("audioState").textContent = stateNames[current.phase];
    $("audioAck").textContent = fmt(current.ackNextSeq) + " / " + fmt(current.totalFrames);
    $("audioSent").textContent = fmt(current.sentFrames) + " / " + fmt(current.totalFrames);
    $("audioBuffer").textContent = fmt(current.bufferSamples) + " samples · " + Math.round(current.bufferSamples / 8) + " ms";
    $("audioPlayed").textContent = duration(current.playedSamples / 8000);
    $("audioRetry").textContent = fmt(current.retransmissions) + " 次";
    $("audioUnderrun").textContent = fmt(current.underruns);
    $("audioFault").textContent = "0x" + current.faults.toString(16).padStart(4, "0") +
      " · " + (Object.keys(AUDIO_REASON).find(k => AUDIO_REASON[k as keyof typeof AUDIO_REASON] === current!.lastReason) ?? "?");
    $("audioSid").textContent = current.sid ? "v1 · SID " + current.sid : "等待握手";
    const p = $<HTMLProgressElement>("audioProgress");
    p.max = audio?.samples ?? 1;
    p.value = Math.min(current.playedSamples, p.max);
    $("audioPercent").textContent = (100 * p.value / p.max).toFixed(1) + "%";
    $("audioError").textContent = current.error;
  }
  input.addEventListener("change", async () => {
    audio = null; current = null;
    const file = input.files?.[0];
    loading = true; render();
    $("audioMeta").textContent = "未选择文件";
    $("audioError").textContent = "";
    try {
      if (file) {
        audio = await loadAudioFile(file);
        $("audioMeta").textContent = audio.name + " · " + fmt(audio.pcm.length) + " B · " +
          duration(audio.durationSeconds) + " · " + fmt(audio.frames.length) + " 帧" +
          (audio.convertedFromWav ? " · 已提取 WAV data" : "");
      }
    } catch (e) { $("audioError").textContent = String(e); }
    finally { loading = false; render(); }
  });
  $("audioPlay").addEventListener("click", async () => {
    if (!audio || active) return;
    const amp = Number($<HTMLInputElement>("audioAmp").value);
    if (!Number.isInteger(amp) || amp < 1 || amp > 200) {
      $("audioError").textContent = "幅值必须为 1..200 mA 整数"; return;
    }
    const axis = $<HTMLSelectElement>("audioAxis").value as "Q" | "D";
    active = true; $("audioError").textContent = ""; render();
    try { await host.start(audio, axis, amp); }
    catch (e) { $("audioError").textContent = String(e instanceof Error ? e.message : e); }
    finally { render(); }
  });
  $("audioPause").addEventListener("click", () => void host.pause());
  $("audioResume").addEventListener("click", () => void host.resume());
  $("audioStop").addEventListener("click", () => void host.stop());

  render();
  return {
    update(s: AudioSnapshot): void { current = s; render(); },
    released(): void { active = false; render(); },
    refresh: render,
  };
}
