import { AUDIO_STATES, audioReason, audioTestTone, audioAmplitudeMax, audioSeekSample, type AudioIo, type AudioPlayer } from "./audio";
import { prepareAudioFile } from "./audio-convert";
import { saveMusic, listMusic, getMusic, deleteMusic, connectMusicLibrary, musicAccessKey, musicSyncMessage, type MusicTrack } from "./music-library";
type Host = {
  ready(): boolean; connected(): boolean; baud(): number; firmwareBaud(): number | undefined; pendingEdits(): boolean;
  amplitudeCapability(axis: "Q" | "D"): number | undefined;
  currentLimitA(): number | undefined;
  prepare(): Promise<void>; command(line: string): Promise<Record<string, string>>;
  background(): boolean; makeSession(io: AudioIo): AudioPlayer;
  write(bytes: Uint8Array): Promise<void>; cancelWrites(): void;
  receiver(fn: ((chunk: Uint8Array) => void) | null): void;
  recover(): Promise<void>; refresh(): void; toast(text: string, kind?: "" | "ok" | "err"): void;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
export function createAudioPanel(h: Host) {
  let busy = false, cancelled = false, session: AudioPlayer | null = null, originalTelem: number | null = null;
  let pcm: Uint8Array | null = null, samples = 0, downloadName = "", loading = false, loadGeneration = 0;
  let lastMax = 0, cleanTask: Promise<boolean> | null = null;
  let tracks: MusicTrack[] = [], selectedMusic = "", startSample = 0, playOffset = 0, segmentSamples = 0;
  let restartAt: number | null = null, restartPaused = false, playingFile = false, scrubbing = false;
  let libraryChannel: BroadcastChannel | null = null;
  const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
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
    const limit = h.currentLimitA(), withinLimit = limit === undefined || !Number.isFinite(limit) || amplitude / 1000 <= limit;
    if (validAmplitude) range.value = amp.value;
    $("audioAmpLimit").textContent = `可调 1–${max} mA · ${axis === "Q" ? "Q 轴转矩电流" : "D 轴磁链电流"}`;
    $<HTMLFieldSetElement>("audioInputs").disabled = busy || !ready;
    $<HTMLFieldSetElement>("audioFileInputs").disabled = busy || loading;
    $("audioDownload").toggleAttribute("disabled", !pcm || busy || loading);
    const safe = $<HTMLInputElement>("audioReady").checked;
    $("audioPlay").toggleAttribute("disabled", busy || loading || !ready || !safe || !pcm || !validAmplitude || !withinLimit);
    $("audioTest").toggleAttribute("disabled", busy || loading || !ready || !safe || !validAmplitude);
    $("audioStop").toggleAttribute("disabled", !busy);
    $("audioDetach").toggleAttribute("disabled", busy);
    $("audioLibrarySync").toggleAttribute("disabled", busy || loading);
    $("audioLibraryKey").toggleAttribute("disabled", busy || loading);
    document.querySelectorAll<HTMLButtonElement>("#audioLibrary button").forEach(button => {
      button.disabled = busy || loading || (button.dataset.action === "play" && (!ready || !safe || !validAmplitude || !withinLimit));
    });
    const seek = $<HTMLInputElement>("audioSeek");
    seek.disabled = loading || !pcm || busy && !playingFile;
    seek.max = String((pcm?.length ?? 0) / 16000);
    const position = busy ? playOffset + (session?.status?.played ?? 0) : startSample;
    if (!scrubbing) seek.value = String(position / 8000);
    $("audioSeekTime").textContent = `${time(Number(seek.value))} / ${time((pcm?.length ?? 0) / 16000)}`;
    $("audioPause").toggleAttribute("disabled", !busy || !session?.sid || ![1, 2, 3].includes(session.status?.state ?? -1));
    $("audioPause").textContent = session?.status?.state === 2 ? "继续" : "暂停";
    const limitHint = limit !== undefined && Number.isFinite(limit) ? `当前普通电流限制 IQ_LIM=${limit} A。${withinLimit ? "" : `所选峰值超过该限制，请先在参数配置中将 IQ_LIM 设为至少 ${amplitude / 1000} A。`}` : "";
    $("audioHint").textContent = busy ? `音频独占串口，${session?.lowTx ? "短 TX 模式已生效（100 ms 状态回传）" : "标准 TX 模式"}。${h.background() ? "后台播放已生效，可切换页面或标签。" : "当前串口不支持后台播放，请保持页面在前台。"}` : ready ? `${axis} 轴峰值上限 ${max} mA。${limitHint}先做小幅短测，再播放文件；停止与 Esc 均可中止。` : "连接与固件匹配的 200000 或 230400 串口后可用。";
    if (session?.status) {
      const s = session.status;
      $<HTMLProgressElement>("audioProgress").value = samples ? 100 * (playOffset + Math.min(s.played, segmentSamples)) / samples : 0;
      $("audioStats").textContent = `${((playOffset + Math.min(s.played, segmentSamples)) / 8000).toFixed(2)} / ${(samples / 8000).toFixed(2)} s · 缓冲 ${s.buffer}/${session.capacity} · ACK ${s.ack} · 欠载 ${s.underruns} · 重传 ${session.retries} · 坏帧 ${session.parser.rejected}`;
      if (busy && !cancelled) $("audioStatus").textContent = `${AUDIO_STATES[s.state]} · ${audioReason(s)}`;
    }
  }
  function check(): void { if (cancelled || !h.connected() || document.visibilityState === "hidden" && !h.background()) throw new Error("音频操作已取消或连接断开"); }
  async function cmd(line: string): Promise<Record<string, string>> { check(); const r = await h.command(line); check(); return r; }
  function abort(reason: string, preserveSeek = false): void { if (!preserveSeek) restartAt = null; if (!busy) return; cancelled = true; session?.cancel(); $("audioStatus").textContent = reason; }
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
  async function start(test: boolean, paused = false): Promise<void> {
    if (busy || loading || !h.ready() || !$<HTMLInputElement>("audioReady").checked) return;
    if (h.pendingEdits()) { h.toast("请先写入或撤回尚未提交的参数修改", "err"); return; }
    const amplitude = Number($<HTMLInputElement>("audioAmp").value), axis = $<HTMLSelectElement>("audioAxis").value as "Q" | "D";
    const max = audioAmplitudeMax(axis, h.amplitudeCapability(axis));
    if (!Number.isInteger(amplitude) || amplitude < 1 || amplitude > max) { h.toast(`${axis} 轴幅度须为 1–${max} mA 的整数`, "err"); return; }
    if (!test && pcm && startSample >= pcm.length / 2) startSample = 0;
    playOffset = test ? 0 : startSample;
    const bytes = test ? audioTestTone() : pcm?.subarray(playOffset * 2);
    if (!bytes) return;
    busy = true; playingFile = !test; cancelled = false; cleanTask = null; originalTelem = null; segmentSamples = bytes.length / 2; samples = test ? segmentSamples : pcm!.length / 2;
    session = h.makeSession({ write: h.write, cancel: h.cancelWrites, connected: h.connected, now: () => performance.now(), sleep, changed: () => refresh() });
    refresh(); h.refresh(); $("audioStatus").textContent = "停机并准备音频…";
    let success = false, failure = "";
    try {
      await h.prepare(); check();
      const initial = await cmd("INFO\n");
      if (initial.audio !== "1" || Number(initial.uart_baud) !== h.baud() || ![200000,230400].includes(h.baud()) || initial.calib !== "1" || Number(initial.fault) || Number(initial.latched)) throw new Error("固件能力、校准或安全状态不满足 AUDIO 要求");
      const verifiedMax = audioAmplitudeMax(axis, Number(initial[axis === "Q" ? "audio_qmax_ma" : "audio_dmax_ma"]));
      if (amplitude > verifiedMax) throw new Error(`${axis} 轴固件峰值上限为 ${verifiedMax} mA`);
      await cmd("GET IQ_LIM\n");
      const limit = h.currentLimitA(), requested = test ? Math.min(5, amplitude) : amplitude;
      if (limit === undefined || !Number.isFinite(limit)) throw new Error("无法读取普通电流限制 IQ_LIM");
      if (requested / 1000 > limit) throw new Error(`所选峰值超过 IQ_LIM=${limit} A，请先将普通电流限制设为至少 ${requested / 1000} A`);
      originalTelem = Number(initial.telem);
      if (![0, 1].includes(originalTelem)) throw new Error("无法读取原遥测状态");
      await cmd("TELEM 0\n"); await cmd("AE 0\n"); await cmd("RUN\n"); await cmd("IQ 0\n");
      await sleep(100); check(); const current = await cmd("INFO\n");
      if (current.run !== "CURRENT" || current.drv !== "1" || current.ae !== "0" || Number(current.fault) || Number(current.latched)) throw new Error("零电流模式未就绪");
      h.receiver(chunk => session?.receive(chunk));
      await session.open(axis, test ? Math.min(5, amplitude) : amplitude); check();
      if (paused) await session.pause();
      await session.play(bytes); success = true;
    } catch (e) { failure = message(e); }
    finally {
      let stopped = false;
      try { stopped = await cleanup(); if (!stopped) failure ||= "串口已断开；电机由音频看门狗停止，请重新连接确认"; }
      catch (e) { failure = `停机/恢复失败：${message(e)}`; }
      h.receiver(null); busy = false;
      const target = restartAt, pausedOnRestart = restartPaused; restartAt = null;
      if (success && !test) startSample = samples;
      $("audioStatus").textContent = failure || (success ? "播放完成 · 已确认停机，遥测已恢复" : "已停止");
      h.toast(failure || "音频播放完成，电机已停止", failure ? "err" : "ok");
      refresh(); h.refresh();
      if (target !== null && stopped && h.connected()) { startSample = target; void start(false, pausedOnRestart); }
    }
  }
  function renderLibrary(): void {
    const container = $("audioLibrary"); container.replaceChildren();
    for (const track of tracks) {
      const row = document.createElement("div"); row.className = `music-row${track.id === selectedMusic ? " active" : ""}`;
      const name = document.createElement("button"); name.className = "ghost music-name"; name.dataset.action = "select";
      const title = document.createElement("strong"); title.textContent = track.name;
      const meta = document.createElement("span"); meta.className = "small"; meta.textContent = `${time(track.samples / 8000)} · ${(track.size / 1024).toFixed(1)} KiB · ${track.cloud ? "已同步" : "本机 / 待同步"}`;
      name.append(title, meta); name.onclick = () => void selectTrack(track).catch(e => h.toast(message(e), "err"));
      const play = document.createElement("button"); play.textContent = "播放"; play.dataset.action = "play"; play.setAttribute("aria-label", `播放 ${track.name}`);
      play.onclick = () => void selectTrack(track).then(() => start(false)).catch(e => h.toast(message(e), "err"));
      const remove = document.createElement("button"); remove.textContent = "删除"; remove.className = "ghost"; remove.dataset.action = "delete"; remove.setAttribute("aria-label", `删除 ${track.name}`);
      remove.onclick = () => void deleteMusic(track.id).then(async () => {
        if (selectedMusic === track.id) { selectedMusic = ""; pcm = null; session = null; startSample = samples = 0; $("audioFileInfo").textContent = "已删除当前音乐"; }
        await reloadLibrary(); libraryChannel?.postMessage("changed");
      }).catch(e => h.toast(message(e), "err"));
      row.append(name, play, remove); container.append(row);
    }
    $("audioLibraryHint").textContent = tracks.length ? `已保存 ${tracks.length} 首 · 点击名称选择，点击播放开始` : "音乐列表为空，选择文件后会自动保存";
    $("audioCloudStatus").textContent = musicSyncMessage();
    refresh();
  }
  async function reloadLibrary(): Promise<void> { tracks = await listMusic(); renderLibrary(); }
  async function selectTrack(track: MusicTrack): Promise<void> {
    if (busy || loading) return;
    loading = true; refresh();
    try { const bytes = await getMusic(track.id); showTrack(track, bytes); }
    finally { loading = false; renderLibrary(); }
  }
  function showTrack(track: MusicTrack, bytes: Uint8Array): void {
    pcm = bytes; samples = track.samples; downloadName = track.downloadName; selectedMusic = track.id;
    session = null; startSample = playOffset = 0;
    $<HTMLProgressElement>("audioProgress").value = 0;
    $("audioFileInfo").textContent = `${track.name} · ${(samples / 8000).toFixed(2)} s · ${samples} 样本 · 8000 Hz / S16LE · 已去除直流偏置`;
    $("audioStatus").textContent = "音乐已就绪，可从列表播放或下载 RAW";
    $("audioStats").textContent = `${(samples / 8000).toFixed(2)} s · ${(bytes.length / 1024).toFixed(1)} KiB`;
  }
  function init(): void {
    $<HTMLInputElement>("audioLibraryKey").value = musicAccessKey();
    $("audioLibrarySync").addEventListener("click", async () => {
      if (busy || loading) return;
      loading = true; refresh(); $("audioCloudStatus").textContent = "正在连接并同步音乐库…";
      try { await connectMusicLibrary($<HTMLInputElement>("audioLibraryKey").value); await reloadLibrary(); libraryChannel?.postMessage("changed"); }
      catch (e) { $("audioCloudStatus").textContent = message(e); h.toast(message(e), "err"); }
      finally { loading = false; refresh(); }
    });
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
    $("audioSeek").addEventListener("input", () => { scrubbing = true; refresh(); });
    $("audioSeek").addEventListener("change", () => {
      scrubbing = false; if (!pcm || loading || busy && !playingFile) return;
      const target = audioSeekSample(Number($<HTMLInputElement>("audioSeek").value), pcm.length / 2);
      if (busy) { restartAt = target; restartPaused = session?.status?.state === 2; abort("正在跳转播放位置…", true); }
      else { startSample = target; session = null; $<HTMLProgressElement>("audioProgress").value = 100 * target / (pcm.length / 2); }
      refresh();
    });
    $("audioFile").addEventListener("change", async event => {
      const files = Array.from((event.target as HTMLInputElement).files ?? []); if (!files.length || busy || loading) return;
      const generation = ++loadGeneration;
      pcm = null; samples = 0; loading = true;
      $<HTMLProgressElement>("audioProgress").value = 0;
      $("audioFileInfo").textContent = `正在读取并保存 ${files.length} 个音乐文件…`;
      refresh();
      try {
        const failures: string[] = [];
        for (const file of files) {
          try {
            const prepared = await prepareAudioFile(file); if (busy || generation !== loadGeneration) return;
            const track = await saveMusic(file.name, prepared); showTrack({ ...track, name: file.name, downloadName: prepared.downloadName }, prepared.bytes);
            $("audioFileInfo").textContent += prepared.converted ? ` · 已转换（${prepared.sourceChannels} 声道 → 单声道）` : " · RAW 已就绪";
          } catch (e) { failures.push(`${file.name}：${message(e)}`); }
        }
        await reloadLibrary(); libraryChannel?.postMessage("changed");
        if (failures.length) { if (!pcm) $("audioFileInfo").textContent = failures.join("；"); $("audioLibraryHint").textContent = failures.join("；"); h.toast(failures.join("；"), "err"); }
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
    if (typeof BroadcastChannel !== "undefined") { libraryChannel = new BroadcastChannel("dr4310-music-library"); libraryChannel.onmessage = () => { if (!busy && !loading) void reloadLibrary().catch(() => {}); }; }
    void reloadLibrary().then(async () => { const id = new URL(location.href).searchParams.get("track"), track = tracks.find(t => t.id === id); if (track) await selectTrack(track); }).catch(e => { $("audioLibraryHint").textContent = message(e); });
    refresh();
  }
  return { init, refresh, abort, stop, get selectedMusic() { return selectedMusic; }, get busy() { return busy; }, get binary() { return session?.binary ?? false; } };
}
