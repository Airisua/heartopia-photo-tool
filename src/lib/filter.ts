import type { Filters, PhotoView } from "./types";

export function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromLocalString(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    return null;
  }
  return date;
}

export function presetRange(
  preset: "today" | "7d" | "30d",
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  if (preset === "7d") start.setDate(start.getDate() - 6);
  if (preset === "30d") start.setDate(start.getDate() - 29);
  return { startDate: localDateString(start), endDate: localDateString(end) };
}

export function photoLocalDate(photo: PhotoView): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(photo.date)) return photo.date;
  const fromTimestamp = new Date(photo.timestampMs);
  return Number.isFinite(photo.timestampMs) ? localDateString(fromTimestamp) : "";
}

export function filterPhotos(photos: PhotoView[], filters: Filters): PhotoView[] {
  const needle = filters.query.trim().toLocaleLowerCase("zh-CN");
  const directory = filters.directory.trim();
  const extension = normalizeExtension(filters.extension);
  const start = filters.startDate || "";
  const end = filters.endDate || "";

  const filtered = photos.filter((photo) => {
    if (directory && photo.directory !== directory) return false;
    if (extension && normalizeExtension(photo.extension) !== extension) return false;
    if (needle) {
      const haystack = `${photo.name}\n${photo.relativePath}`.toLocaleLowerCase("zh-CN");
      if (!haystack.includes(needle)) return false;
    }
    if (start || end) {
      const date = photoLocalDate(photo);
      if (!date) return false;
      if (start && date < start) return false;
      if (end && date > end) return false;
    }
    return true;
  });

  return filtered.sort(
    (left, right) =>
      right.timestampMs - left.timestampMs || left.relativePath.localeCompare(right.relativePath, "zh-CN"),
  );
}

export function normalizeExtension(extension: string): string {
  return extension.trim().toLowerCase().replace(/^\./, "");
}

export function filterValidationMessage(filters: Filters): string | null {
  if (filters.startDate && !dateFromLocalString(filters.startDate)) {
    return "起始日期格式无效。";
  }
  if (filters.endDate && !dateFromLocalString(filters.endDate)) {
    return "结束日期格式无效。";
  }
  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
    return "起始日期不能晚于结束日期。";
  }
  return null;
}

export function countActiveFilters(filters: Filters): number {
  let count = 0;
  if (filters.directory) count += 1;
  if (filters.extension) count += 1;
  if (filters.query.trim()) count += 1;
  if (filters.startDate || filters.endDate || filters.datePreset === "custom") count += 1;
  return count;
}
