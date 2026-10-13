/** Strict, headerless s16le/8kHz/mono PCM input (or validated RIFF PCM WAV). */
export const AUDIO_RATE = 8000;
export const AUDIO_CHUNK_SAMPLES = 160;

export type AudioInput = {
  name: string;
  pcm: Uint8Array;
  samples: number;
  durationSeconds: number;
  frames: Uint8Array[];
  convertedFromWav: boolean;
};

function fail(message: string): never { throw new Error(message); }
function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}

/** Parse a complete file without assuming the WAV data chunk starts at offset 44. */
export function parseAudioBytes(name: string, input: Uint8Array): AudioInput {
  const suffix = name.toLowerCase();
  const wav = suffix.endsWith(".wav");
  if (!wav && !suffix.endsWith(".raw") && !suffix.endsWith(".pcm"))
    fail("仅接受 .raw、.pcm 或符合要求的 .wav 文件");
  let pcm = input;
  if (wav) {
    if (input.length < 12 || fourcc(input, 0) !== "RIFF" || fourcc(input, 8) !== "WAVE")
      fail("不是有效的 RIFF/WAVE 文件");
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const riffEnd = view.getUint32(4, true) + 8;
    if (riffEnd > input.length || riffEnd < 12) fail("WAV RIFF 长度非法或文件已截断");
    let fmt = false, data: Uint8Array | null = null;
    for (let off = 12; off + 8 <= riffEnd;) {
      const size = view.getUint32(off + 4, true);
      const start = off + 8, end = start + size;
      if (end > riffEnd) fail("WAV chunk 长度超出文件");
      const id = fourcc(input, off);
      if (id === "fmt ") {
        if (size < 16) fail("WAV fmt 块过短");
        if (view.getUint16(start, true) !== 1 ||
            view.getUint16(start + 2, true) !== 1 ||
            view.getUint32(start + 4, true) !== AUDIO_RATE ||
            view.getUint32(start + 8, true) !== AUDIO_RATE * 2 ||
            view.getUint16(start + 12, true) !== 2 ||
            view.getUint16(start + 14, true) !== 16)
          fail("WAV 必须是 PCM、8000 Hz、单声道、16-bit");
        fmt = true;
      } else if (id === "data" && data === null) data = input.slice(start, end);
      off = end + (size & 1);
    }
    if (!fmt || !data) fail("WAV 缺少有效 fmt 或 data 块");
    pcm = data;
  }
  if (!pcm.length || (pcm.length & 1)) fail("PCM 必须非空且字节数为偶数（16-bit LE）");
  const frames: Uint8Array[] = [];
  for (let off = 0; off < pcm.length; off += AUDIO_CHUNK_SAMPLES * 2)
    frames.push(pcm.subarray(off, Math.min(pcm.length, off + AUDIO_CHUNK_SAMPLES * 2)));
  return {
    name, pcm, samples: pcm.length / 2, durationSeconds: pcm.length / (2 * AUDIO_RATE),
    frames, convertedFromWav: wav,
  };
}

export async function loadAudioFile(file: File): Promise<AudioInput> {
  return parseAudioBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}
