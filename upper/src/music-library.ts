import type { PreparedAudioFile } from "./audio-convert";
import { isMusicTrack, MUSIC_MAX_BYTES, type MusicTrack } from "./music-model";
export type { MusicTrack } from "./music-model";

const DB_NAME = "dr4310-music";
const KEY_NAME = "dr4310-music-access";
let memoryKey = "", syncMessage = "填写音乐库访问码后，可在其他电脑同步音乐";
const deleted = new Set<string>();
export function musicAccessKey(): string { try { return memoryKey || localStorage.getItem(KEY_NAME) || ""; } catch { return memoryKey; } }
export function musicSyncMessage(): string { return syncMessage; }
async function remote(path = "", init: RequestInit = {}, key = musicAccessKey()): Promise<Response> {
  if (!key) throw new Error("请先填写音乐库访问码");
  const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${key}`);
  const response = await fetch(new URL(`./api/music${path}`, document.baseURI), { ...init, headers, cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? "无法连接云端音乐库，请在 dr4310.233688.xyz 使用同步");
  }
  return response;
}
async function cloudTracks(key = musicAccessKey()): Promise<MusicTrack[]> {
  const tracks: MusicTrack[] = [], seen = new Set<string>(); let cursor: string | null = null;
  do {
    const response = await remote(cursor ? `?cursor=${encodeURIComponent(cursor)}` : "", {}, key);
    const data = await response.json() as { tracks: unknown[]; cursor: string | null };
    if (!Array.isArray(data.tracks) || !data.tracks.every(isMusicTrack)) throw new Error("云端音乐列表格式无效");
    tracks.push(...data.tracks.map(t => ({ ...t, cloud: true })));
    cursor = data.cursor; if (cursor && seen.has(cursor)) throw new Error("云端音乐列表分页无效"); if (cursor) seen.add(cursor);
  } while (cursor);
  return tracks;
}
async function upload(track: MusicTrack, bytes: Uint8Array): Promise<MusicTrack> {
  const response = await remote(`/${track.id}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Music-Name": encodeURIComponent(track.name), "X-Music-Download": encodeURIComponent(track.downloadName) }, body: new Uint8Array(bytes).buffer });
  const metadata = await response.json(); if (!isMusicTrack(metadata)) throw new Error("云端音乐信息无效");
  return { ...metadata, cloud: true };
}
async function putTrack(track: MusicTrack, bytes?: Uint8Array): Promise<void> {
  await transaction<void>(bytes ? ["tracks", "pcm"] : ["tracks"], "readwrite", (tx, done) => {
    tx.objectStore("tracks").put(track); if (bytes) tx.objectStore("pcm").put({ id: track.id, bytes: new Uint8Array(bytes).buffer }); done();
  });
}
export async function connectMusicLibrary(key: string): Promise<void> {
  const value = key.trim(); await cloudTracks(value);
  memoryKey = value; try { localStorage.setItem(KEY_NAME, value); } catch { /* this session can still synchronize */ }
  for (const track of await localTracks()) if (!track.cloud) { const synced = await upload(track, await getMusic(track.id)); await putTrack(synced); }
  syncMessage = "云端已连接，其他电脑使用同一访问码即可同步";
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("tracks", { keyPath: "id" });
      request.result.createObjectStore("pcm", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("无法打开音乐列表，请允许网站存储"));
    request.onblocked = () => reject(new Error("音乐列表被其他页面占用，请刷新其他 DR4310 页面"));
  });
}
async function transaction<T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction, done: (value: T) => void) => void): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode); let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(new Error(tx.error?.name === "QuotaExceededError" ? "浏览器存储空间不足，请删除部分音乐后重试" : "音乐列表读写失败"));
      run(tx, result => { value = result; });
    });
  } finally { db.close(); }
}
export async function saveMusic(name: string, prepared: PreparedAudioFile): Promise<MusicTrack> {
  const bytes = new Uint8Array(prepared.bytes).buffer;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  const track: MusicTrack = { id, name, downloadName: prepared.downloadName, samples: prepared.samples, size: bytes.byteLength, addedAt: Date.now() };
  let saved = await transaction<MusicTrack>(["tracks", "pcm"], "readwrite", (tx, done) => {
    const found = tx.objectStore("tracks").get(id);
    found.onsuccess = () => {
      if (found.result) { done(found.result as MusicTrack); return; }
      tx.objectStore("tracks").put(track); tx.objectStore("pcm").put({ id, bytes }); done(track);
    };
  });
  deleted.delete(id);
  if (musicAccessKey() && !saved.cloud) {
    try { saved = await upload(saved, new Uint8Array(bytes)); await putTrack(saved); syncMessage = "音乐已保存到云端，可在其他电脑播放"; }
    catch (e) { syncMessage = `已保存在当前浏览器，待同步：${e instanceof Error ? e.message : String(e)}`; }
  }
  return saved;
}
function localTracks(): Promise<MusicTrack[]> {
  return transaction(["tracks"], "readonly", (tx, done) => {
    const request = tx.objectStore("tracks").getAll();
    request.onsuccess = () => done((request.result as MusicTrack[]).sort((a, b) => b.addedAt - a.addedAt));
  });
}
export async function listMusic(): Promise<MusicTrack[]> {
  const local = await localTracks(); if (!musicAccessKey()) return local;
  try {
    const remote = await cloudTracks(), combined = new Map(remote.filter(t => !deleted.has(t.id)).map(t => [t.id, t]));
    for (const track of local) if (!deleted.has(track.id) && (!track.cloud || Date.now() - track.addedAt < 120000) && !combined.has(track.id)) combined.set(track.id, track);
    for (const track of remote) if (!deleted.has(track.id)) await putTrack(track);
    syncMessage = "云端音乐库已同步";
    return [...combined.values()].sort((a, b) => b.addedAt - a.addedAt);
  } catch (e) { syncMessage = `当前使用本机缓存：${e instanceof Error ? e.message : String(e)}`; return local.filter(t => !deleted.has(t.id)); }
}
export async function getMusic(id: string): Promise<Uint8Array> {
  const cached = await transaction<Uint8Array | null>(["pcm"], "readonly", (tx, done) => {
    const request = tx.objectStore("pcm").get(id);
    request.onsuccess = () => done(request.result ? new Uint8Array(request.result.bytes) : null);
  });
  if (cached) return cached;
  const response = await remote(`/${id}`), bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length % 2 || bytes.length > MUSIC_MAX_BYTES) throw new Error("云端音乐数据无效");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  if (Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("") !== id) throw new Error("云端音乐校验失败");
  const track = (await localTracks()).find(t => t.id === id); if (track) await putTrack(track, bytes);
  return bytes;
}
export async function deleteMusic(id: string): Promise<void> {
  const track = (await localTracks()).find(t => t.id === id);
  if (track?.cloud) await remote(`/${id}`, { method: "DELETE" });
  deleted.add(id);
  await transaction<void>(["tracks", "pcm"], "readwrite", (tx, done) => { for (const name of ["tracks", "pcm"]) tx.objectStore(name).delete(id); done(); });
}
