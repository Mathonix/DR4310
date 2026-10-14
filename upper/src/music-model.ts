export type MusicTrack = { id: string; name: string; downloadName: string; samples: number; size: number; addedAt: number; cloud?: boolean };
export const MUSIC_MAX_BYTES = 8000 * 2 * 300;
export function isMusicTrack(value: unknown): value is MusicTrack {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<MusicTrack>;
  return typeof t.id === "string" && /^[a-f0-9]{64}$/.test(t.id) && typeof t.name === "string" && typeof t.downloadName === "string" &&
    Number.isSafeInteger(t.samples) && t.samples! > 0 && t.samples! <= MUSIC_MAX_BYTES / 2 && t.size === t.samples! * 2 && Number.isFinite(t.addedAt);
}
