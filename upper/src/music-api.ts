import { MUSIC_MAX_BYTES, type MusicTrack } from "./music-model";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
export async function musicApi(request: Request, env: Cloudflare.Env): Promise<Response> {
  if (!env.MUSIC_KV || !env.MUSIC_LIBRARY_KEY) return json({ error: "云端音乐库尚未配置" }, 503);
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  if (!supplied || supplied.length > 256) return json({ error: "请输入音乐库访问码" }, 401);
  const enc = new TextEncoder();
  const [actual, expected] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(supplied)), crypto.subtle.digest("SHA-256", enc.encode(env.MUSIC_LIBRARY_KEY))]);
  if (!crypto.subtle.timingSafeEqual(actual, expected)) return json({ error: "音乐库访问码无效" }, 401);
  const url = new URL(request.url), id = url.pathname.slice("/api/music/".length);
  try {
    if (url.pathname === "/api/music" && request.method === "GET") {
      const list = await env.MUSIC_KV.list<MusicTrack>({ prefix: "music:", limit: 1000, cursor: url.searchParams.get("cursor") ?? undefined });
      return json({ tracks: list.keys.flatMap(key => key.metadata ? [{ ...key.metadata, cloud: true }] : []), cursor: list.list_complete ? null : list.cursor });
    }
    if (!/^[a-f0-9]{64}$/.test(id)) return json({ error: "音乐编号无效" }, 400);
    const key = `music:${id}`;
    if (request.method === "GET") {
      const result = await env.MUSIC_KV.getWithMetadata<MusicTrack>(key, "stream");
      if (!result.value) return json({ error: "音乐不存在，可能已删除" }, 404);
      return new Response(result.value, { headers: { ...headers, "Content-Type": "application/octet-stream" } });
    }
    if (request.method === "DELETE") { await env.MUSIC_KV.delete(key); return json({ ok: true }); }
    if (request.method !== "PUT") return json({ error: "不支持此操作" }, 405);
    if (!request.body || Number(request.headers.get("Content-Length")) > MUSIC_MAX_BYTES) return json({ error: "音频最长 5 分钟" }, 413);
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > MUSIC_MAX_BYTES) { await reader.cancel(); return json({ error: "音频最长 5 分钟" }, 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!length || length % 2) return json({ error: "音乐必须为非空的 S16LE PCM" }, 400);
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    if (Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("") !== id) return json({ error: "音乐数据校验失败" }, 400);
    const name = decodeURIComponent(request.headers.get("X-Music-Name") ?? "music.raw").slice(0, 120);
    const downloadName = decodeURIComponent(request.headers.get("X-Music-Download") ?? "music.s16le.raw").slice(0, 120);
    const track: MusicTrack = { id, name, downloadName, samples: length / 2, size: length, addedAt: Date.now(), cloud: true };
    const existing = await env.MUSIC_KV.getWithMetadata<MusicTrack>(key, "stream");
    if (existing.value) { await existing.value.cancel(); return json(existing.metadata ?? track); }
    await env.MUSIC_KV.put(key, bytes.buffer, { metadata: track }); return json(track, 201);
  } catch (e) {
    console.error(JSON.stringify({ event: "music_api_error", message: e instanceof Error ? e.message : String(e) }));
    return json({ error: "云端音乐库暂时不可用，请稍后重试" }, 503);
  }
}
