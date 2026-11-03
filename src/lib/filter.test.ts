import { describe, expect, it } from "vitest";
import {
  countActiveFilters,
  dateFromLocalString,
  filterPhotos,
  filterValidationMessage,
  localDateString,
  presetRange,
} from "./filter";
import { EMPTY_FILTERS } from "./types";
import { makePhoto } from "../test/fixtures";

describe("date presets and filtering", () => {
  const now = new Date(2026, 10, 3, 16, 45, 0);

  it("computes inclusive local calendar ranges", () => {
    expect(presetRange("today", now)).toEqual({
      startDate: "2026-11-03",
      endDate: "2026-11-03",
    });
    expect(presetRange("7d", now)).toEqual({
      startDate: "2026-10-28",
      endDate: "2026-11-03",
    });
    expect(presetRange("30d", now)).toEqual({
      startDate: "2026-10-05",
      endDate: "2026-11-03",
    });
    expect(localDateString(now)).toBe("2026-11-03");
    expect(dateFromLocalString("2026-02-30")).toBeNull();
  });

  it("includes both range boundaries and excludes outside dates", () => {
    const photos = [
      makePhoto(1, {
        id: "before",
        date: "2026-10-27",
        timestampMs: new Date(2026, 9, 27, 12, 0).getTime(),
      }),
      makePhoto(2, {
        id: "start",
        date: "2026-10-28",
        timestampMs: new Date(2026, 9, 28, 12, 0).getTime(),
      }),
      makePhoto(3, {
        id: "middle",
        date: "2026-11-01",
        timestampMs: new Date(2026, 10, 1, 12, 0).getTime(),
      }),
      makePhoto(4, {
        id: "end",
        date: "2026-11-03",
        timestampMs: new Date(2026, 10, 3, 12, 0).getTime(),
      }),
      makePhoto(5, {
        id: "after",
        date: "2026-11-04",
        timestampMs: new Date(2026, 10, 4, 12, 0).getTime(),
      }),
    ];
    const result = filterPhotos(photos, {
      ...EMPTY_FILTERS,
      datePreset: "custom",
      startDate: "2026-10-28",
      endDate: "2026-11-03",
    });
    expect(result.map((photo) => photo.id)).toEqual(["end", "middle", "start"]);
  });

  it("combines directory, extension and case-insensitive query filters", () => {
    const photos = [
      makePhoto(1, { id: "photo", directory: "Photo", extension: "jpg", name: "Sunset_1920.jpg" }),
      makePhoto(2, {
        id: "draw",
        directory: "Draw",
        extension: "png",
        name: "flower.png",
        relativePath: "Draw/flower.png",
      }),
      makePhoto(3, {
        id: "photo-png",
        directory: "Photo",
        extension: "png",
        name: "sunset.png",
        relativePath: "Photo/sunset.png",
      }),
    ];
    expect(
      filterPhotos(photos, {
        ...EMPTY_FILTERS,
        directory: "Photo",
        extension: ".PNG",
        query: "SUNSET",
      }).map((photo) => photo.id),
    ).toEqual(["photo-png"]);
  });

  it("falls back to the timestamp when the server-safe date is empty", () => {
    const photo = makePhoto(1, {
      id: "fallback",
      date: "",
      timestampMs: new Date(2026, 9, 28, 9, 0, 0).getTime(),
    });
    expect(
      filterPhotos([photo], {
        ...EMPTY_FILTERS,
        startDate: "2026-10-28",
        endDate: "2026-10-28",
      }),
    ).toHaveLength(1);
  });

  it("reports invalid ranges and counts active filters", () => {
    expect(
      filterValidationMessage({
        ...EMPTY_FILTERS,
        startDate: "2026-11-10",
        endDate: "2026-11-03",
      }),
    ).toContain("不能晚于");
    expect(
      countActiveFilters({
        directory: "Photo",
        extension: ".jpg",
        query: "sun",
        startDate: "2026-10-01",
        endDate: "2026-11-03",
        datePreset: "custom",
      }),
    ).toBe(4);
  });
});
