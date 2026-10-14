import { afterEach, describe, expect, it, vi } from "vitest";
import { timingSafeEqual, webcrypto } from "node:crypto";
import { musicApi } from "../src/music-api";
import { audioSeekSample } from "../src/audio";
import { isMusicTrack } from "../src/music-model";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal("crypto", { subtle: { digest: webcrypto.subtle.digest.bind(webcrypto.subtle), timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b)) } });
  const entries = new Map<string, { bytes: ArrayBuffer; metadata: unknown }>();
  const kv = {
    list: vi.fn(async () => ({ keys: [...entries].map(([name, value]) => ({ name, metadata: value.metadata })), list_complete: true })),
    getWithMetadata: vi.fn(async (key: string) => { const entry = entries.get(key); return { value: entry ? new ReadableStream({ start(c) { c.enqueue(new Uint8Array(entry.bytes)); c.close(); } }) : null, metadata: entry?.metadata ?? null }; }),
    put: vi.fn(async (key: string, bytes: ArrayBuffer, options: { metadata: unknown }) => { entries.set(key, { bytes, metadata: options.metadata }); }),
    delete: vi.fn(async (key: string) => { entries.delete(key); }),
  };
  const env = { MUSIC_KV: kv, MUSIC_LIBRARY_KEY: "test-secret" } as unknown as Cloudflare.Env;
  const request = (path: string, method = "GET", body?: Uint8Array, authorized = true, extra: Record<string, string> = {}) => new Request("https://dr4310.test/api/music" + path, { method, headers: { ...(authorized ? { Authorization: "Bearer test-secret" } : {}), ...extra }, body: body ? new Uint8Array(body).buffer : undefined });
  return { kv, env, entries, request };
}
async function id(bytes: Uint8Array): Promise<string> {
  const digest = await webcrypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Buffer.from(digest).toString("hex");
}
describe("private cloud music library", () => {
  it("rejects unauthorized read/write/delete before touching storage", async () => {
    const f = fixture();
    for (const method of ["GET", "PUT", "DELETE"]) expect((await musicApi(f.request("/" + "a".repeat(64), method, method === "PUT" ? new Uint8Array(2) : undefined, false), f.env)).status).toBe(401);
    expect(f.kv.list).not.toHaveBeenCalled(); expect(f.kv.put).not.toHaveBeenCalled(); expect(f.kv.delete).not.toHaveBeenCalled();
    expect((await musicApi(f.request("", "GET", undefined, true, { Authorization: "Bearer wrong" }), f.env)).status).toBe(401);
  });
  it("round trips S16LE bytes and metadata, deduplicates, then deletes", async () => {
    const f = fixture(), bytes = new Uint8Array([0, 0, 255, 127, 0, 128]), hash = await id(bytes);
    const write = await musicApi(f.request("/" + hash, "PUT", bytes, true, { "X-Music-Name": encodeURIComponent("音乐.raw") }), f.env);
    expect(write.status).toBe(201); expect(isMusicTrack(await write.json())).toBe(true);
    expect((await musicApi(f.request("/" + hash, "PUT", bytes), f.env)).status).toBe(200); expect(f.kv.put).toHaveBeenCalledOnce();
    const listed = await (await musicApi(f.request(""), f.env)).json() as { tracks: { name: string }[]; cursor: null };
    expect(listed.tracks[0]?.name).toBe("音乐.raw"); expect(listed.cursor).toBe(null);
    const fetched = await musicApi(f.request("/" + hash), f.env); expect(fetched.headers.get("Cache-Control")).toBe("no-store"); expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(bytes);
    expect((await musicApi(f.request("/" + hash, "DELETE"), f.env)).status).toBe(200);
    expect((await musicApi(f.request("/" + hash), f.env)).status).toBe(404);
  });
  it("rejects malformed or incorrectly identified PCM without persisting it", async () => {
    const f = fixture(), hash = "a".repeat(64);
    for (const bytes of [new Uint8Array(), new Uint8Array([1]), new Uint8Array([1, 2])]) expect((await musicApi(f.request("/" + hash, "PUT", bytes), f.env)).status).toBe(400);
    expect((await musicApi(f.request("/bad", "PUT", new Uint8Array(2)), f.env)).status).toBe(400); expect(f.kv.put).not.toHaveBeenCalled();
  });
  it("enforces the five-minute cap for declared and streamed bodies", async () => {
    const f = fixture(), path = "/" + "a".repeat(64);
    expect((await musicApi(f.request(path, "PUT", new Uint8Array(2), true, { "Content-Length": "4800001" }), f.env)).status).toBe(413);
    expect((await musicApi(f.request(path, "PUT", new Uint8Array(4800002)), f.env)).status).toBe(413); expect(f.kv.put).not.toHaveBeenCalled();
  });
  it("propagates pagination without reading every PCM object", async () => {
    const f = fixture(); f.kv.list.mockResolvedValueOnce({ keys: [], list_complete: false, cursor: "next" } as any);
    expect(await (await musicApi(f.request("?cursor=start"), f.env)).json()).toEqual({ tracks: [], cursor: "next" });
    expect(f.kv.list).toHaveBeenCalledWith({ prefix: "music:", limit: 1000, cursor: "start" }); expect(f.kv.getWithMetadata).not.toHaveBeenCalled();
  });
});
describe("PCM seeking", () => {
  it("maps time to an even byte boundary and clamps to a nonempty tail", () => {
    expect(audioSeekSample(1.125, 16000)).toBe(9000); expect(audioSeekSample(-2, 16000)).toBe(0);
    expect(audioSeekSample(100, 16000)).toBe(15999); expect(audioSeekSample(NaN, 16000)).toBe(0); expect(audioSeekSample(1, 0)).toBe(0);
  });
});
