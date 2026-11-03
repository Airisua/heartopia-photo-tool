import { beforeEach, describe, expect, it, vi } from "vitest";
import { getThumbnail } from "./api";
import {
  THUMBNAIL_MAX_IN_FLIGHT,
  THUMBNAIL_MAX_QUEUED,
  clearThumbnailCache,
  loadThumbnail,
  peekThumbnail,
  thumbnailCacheState,
} from "./thumbnailCache";

vi.mock("./api", () => ({
  getThumbnail: vi.fn(),
}));

const mockedGetThumbnail = vi.mocked(getThumbnail);

describe("thumbnail cache concurrency and stale generations", () => {
  beforeEach(() => {
    clearThumbnailCache();
    mockedGetThumbnail.mockReset();
  });

  it("resolves failed thumbnail commands to null and caches the failure", async () => {
    mockedGetThumbnail.mockRejectedValueOnce(new Error("native decode failed"));
    await expect(loadThumbnail("broken")).resolves.toBeNull();
    expect(peekThumbnail("broken")).toBeNull();
    expect(thumbnailCacheState()).toMatchObject({
      pending: 0,
      queued: 0,
      active: 0,
    });
  });

  it("does not cache results returned after a generation reset", async () => {
    let resolveNative: ((value: string | null) => void) | undefined;
    mockedGetThumbnail.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolveNative = resolve;
        }),
    );
    const request = loadThumbnail("stale");
    expect(thumbnailCacheState().active).toBe(1);
    clearThumbnailCache();
    await expect(request).resolves.toBeNull();
    resolveNative?.("data:image/jpeg;base64,AAAA");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peekThumbnail("stale")).toBeUndefined();
    expect(thumbnailCacheState()).toMatchObject({
      cacheEntries: 0,
      pending: 0,
      active: 0,
    });
  });

  it("bounds the pending queue and drops the oldest waiting request", async () => {
    mockedGetThumbnail.mockImplementation(
      () => new Promise<string | null>(() => undefined),
    );
    const requests = Array.from(
      { length: THUMBNAIL_MAX_IN_FLIGHT + THUMBNAIL_MAX_QUEUED + 5 },
      (_, index) => loadThumbnail(`queued-${index}`),
    );
    await Promise.resolve();
    expect(thumbnailCacheState()).toMatchObject({
      active: THUMBNAIL_MAX_IN_FLIGHT,
      queued: THUMBNAIL_MAX_QUEUED,
      pending: THUMBNAIL_MAX_IN_FLIGHT + THUMBNAIL_MAX_QUEUED,
    });
    await expect(requests[THUMBNAIL_MAX_IN_FLIGHT]).resolves.toBeNull();
    clearThumbnailCache();
  });
});
