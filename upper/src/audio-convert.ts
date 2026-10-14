import { preparePcm } from "./audio";

export const AUDIO_RATE = 8000;
export const AUDIO_MAX_SECONDS = 300;
export const AUDIO_MAX_FILE_BYTES = 64 * 1024 * 1024;
export type PreparedAudioFile = ReturnType<typeof preparePcm> & {
  converted: boolean; sourceChannels: number; downloadName: string;
};
type DecodedAudio = Pick<AudioBuffer, "sampleRate" | "length" | "numberOfChannels" | "getChannelData">;
type Decoder = (bytes: ArrayBuffer) => Promise<DecodedAudio>;

/** Average channels without raising gain; explicitly encode signed, little-endian PCM. */
export function monoS16le(channels: readonly Float32Array[]): Uint8Array {
  const count = channels[0]?.length ?? 0;
  if (!count || count > AUDIO_RATE * AUDIO_MAX_SECONDS) throw new Error("音频须非空且不超过 5 分钟");
  if (!channels.length || channels.length > 32 || channels.some(c => c.length !== count)) throw new Error("音频声道数据无效");
  const bytes = new Uint8Array(count * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    let sample = 0;
    for (const channel of channels) {
      const value = channel[i]!;
      if (!Number.isFinite(value)) throw new Error("音频包含无效样本");
      sample += value / channels.length;
    }
    sample = Math.max(-1, Math.min(1, sample));
    view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

async function decodeAt8k(bytes: ArrayBuffer): Promise<DecodedAudio> {
  if (typeof OfflineAudioContext === "undefined") throw new Error("浏览器不支持本地音频转换，请使用新版 Chrome 或 Edge");
  // decodeAudioData resamples to the context rate. Offline context never opens
  // an output device or sends the music to the computer's speakers.
  const context = new OfflineAudioContext(1, 1, AUDIO_RATE);
  try { return await context.decodeAudioData(bytes); }
  catch { throw new Error("音频无法解码：文件损坏或格式不受浏览器支持，请尝试 MP3 / WAV / FLAC"); }
}

export async function prepareAudioFile(file: Pick<File, "name" | "size" | "arrayBuffer">, decode: Decoder = decodeAt8k): Promise<PreparedAudioFile> {
  const raw = /\.(raw|pcm|s16|s16le)$/i.test(file.name);
  if (!file.size) throw new Error("音频文件为空");
  if (file.size > (raw ? AUDIO_RATE * 2 * AUDIO_MAX_SECONDS : AUDIO_MAX_FILE_BYTES)) throw new Error(raw ? "音频最长 5 分钟" : "音乐文件最大 64 MiB");
  const input = await file.arrayBuffer();
  let bytes: Uint8Array, sourceChannels = 1;
  if (raw) bytes = new Uint8Array(input);
  else {
    const decoded = await decode(input);
    if (decoded.sampleRate !== AUDIO_RATE) throw new Error("浏览器未能将音频转换为 8000 Hz");
    if (!decoded.length || decoded.length > AUDIO_RATE * AUDIO_MAX_SECONDS) throw new Error("音频须非空且不超过 5 分钟");
    sourceChannels = decoded.numberOfChannels;
    if (sourceChannels < 1 || sourceChannels > 32) throw new Error("音频声道数据无效");
    bytes = monoS16le(Array.from({ length: sourceChannels }, (_, i) => decoded.getChannelData(i)));
  }
  const stem = file.name.replace(/(?:\.8k-mono\.s16le)?\.[^.]+$/, "") || "audio";
  return { ...preparePcm(bytes), converted: !raw, sourceChannels, downloadName: `${stem}.8k-mono.s16le.raw` };
}
