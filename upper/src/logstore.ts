/** IndexedDB store for CSV recordings (数据存储 → 日志管理). */
export type LogMeta = { id: number; name: string; created: number; rows: number; bytes: number; source: string };
type LogRec = LogMeta & { csv: string };

const DB = "dr4310-logs", STORE = "recordings";
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    if (typeof indexedDB === "undefined") return rej(new Error("浏览器不支持 IndexedDB"));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error ?? new Error("IndexedDB 打开失败")); };
  });
  return dbp;
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req.result);
    t.onerror = () => rej(t.error ?? req.error);
    t.onabort = () => rej(t.error ?? new Error("事务中止"));
  }));
}
export async function saveLog(name: string, csv: string, rows: number, source: string): Promise<number> {
  const rec: Omit<LogRec, "id"> = { name, created: Date.now(), rows, bytes: new TextEncoder().encode(csv).byteLength, source, csv };
  return (await tx("readwrite", (s) => s.add(rec))) as number;
}
export async function listLogs(): Promise<LogMeta[]> {
  const all = (await tx("readonly", (s) => s.getAll())) as LogRec[];
  return all.map(({ csv: _c, ...m }) => m).sort((a, b) => b.created - a.created);
}
export async function getLog(id: number): Promise<LogRec | undefined> {
  return (await tx("readonly", (s) => s.get(id))) as LogRec | undefined;
}
export async function deleteLog(id: number): Promise<void> { await tx("readwrite", (s) => s.delete(id)); }
export async function clearLogs(): Promise<void> { await tx("readwrite", (s) => s.clear()); }
