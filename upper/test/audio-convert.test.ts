import { describe, expect, it } from "vitest";
import { AUDIO_MAX_FILE_BYTES, monoS16le, prepareAudioFile } from "../src/audio-convert";

const input = (name = "music.wav", size = 10) => ({ name, size, arrayBuffer: async () => new ArrayBuffer(size) });
const decoded = (channels: Float32Array[], sampleRate = 8000) => ({ sampleRate, length: channels[0]!.length, numberOfChannels: channels.length, getChannelData: (i: number) => channels[i]! });

describe("music conversion", () => {
  it("averages stereo, keeps gain, clips safely and encodes signed little-endian samples", () => {
    const bytes = monoS16le([new Float32Array([-1, 1, .5, 2, 0]), new Float32Array([-1, 1, -.5, 2, .5])]);
    const data = new DataView(bytes.buffer);
    expect(Array.from({ length: 5 }, (_, i) => data.getInt16(i * 2, true))).toEqual([-32768, 32767, 0, 32767, 8192]);
    expect([...bytes.slice(0, 4)]).toEqual([0, 128, 255, 127]);
  });
  it("rejects empty, mismatched, nonfinite and overlong audio before packing", () => {
    expect(() => monoS16le([])).toThrow();
    expect(() => monoS16le([new Float32Array(1), new Float32Array(2)])).toThrow();
    expect(() => monoS16le([new Float32Array([NaN])])).toThrow();
    expect(() => monoS16le([new Float32Array(8000 * 300 + 1)])).toThrow("5 分钟");
  });
  it("prepares ordinary music for direct playback and downloads, removing DC once", async () => {
    const channels = [new Float32Array([.25, .5, -.25]), new Float32Array([.25, 0, -.25])];
    const result = await prepareAudioFile(input("雨の日.mp3"), async () => decoded(channels));
    expect(result.converted).toBe(true); expect(result.sourceChannels).toBe(2);
    expect(result.samples).toBe(3); expect(result.bytes.length).toBe(6);
    expect(result.removedDc).toBeGreaterThan(2000);
    expect(result.downloadName).toBe("雨の日.8k-mono.s16le.raw");
  });
  it("loads RAW without using a browser decoder", async () => {
    const result = await prepareAudioFile(input("music.RAW", 8), async () => { throw new Error("must not decode"); });
    expect(result.converted).toBe(false); expect(result.samples).toBe(4);
  });
  it("checks size before decoding and rejects wrong resampling or long decoded music", async () => {
    let calls = 0;
    const decode = async () => { calls++; return decoded([new Float32Array(1)]); };
    await expect(prepareAudioFile(input("x.mp3", AUDIO_MAX_FILE_BYTES + 1), decode)).rejects.toThrow("64 MiB");
    await expect(prepareAudioFile(input("x.raw", 4800002), decode)).rejects.toThrow("5 分钟");
    await expect(prepareAudioFile(input("x.mp3", 0), decode)).rejects.toThrow("为空");
    expect(calls).toBe(0);
    await expect(prepareAudioFile(input(), async () => decoded([new Float32Array(1)], 44100))).rejects.toThrow("8000 Hz");
    await expect(prepareAudioFile(input(), async () => decoded([new Float32Array(2400001)]))).rejects.toThrow("5 分钟");
  });
});
