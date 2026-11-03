import type { PhotoView } from "../lib/types";

const baseTime = new Date(2026, 10, 3, 14, 30, 0).getTime();

export function makePhoto(index: number, overrides: Partial<PhotoView> = {}): PhotoView {
  const timestampMs = baseTime - index * 60_000;
  return {
    id: `photo-${index}`,
    name: `20261028_120000_1920_1080.jpg`,
    relativePath: `Photo/20261028_120000_1920_1080.jpg`,
    directory: "Photo",
    size: 1_024_000 + index,
    extension: "jpg",
    date: "2026-11-03",
    timestampMs,
    dateSource: "filetime",
    status: "pending",
    ...overrides,
  };
}

export function makePhotos(count: number): PhotoView[] {
  return Array.from({ length: count }, (_, index) => makePhoto(index));
}
