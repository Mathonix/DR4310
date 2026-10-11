/** Browser storage is optional: disabled storage or damaged JSON must not disable E-stop. */
export function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function writeStored(key: string, value: string | null): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* optional */ }
}
export function readObject(key: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readStored(key) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch { return {}; }
}
